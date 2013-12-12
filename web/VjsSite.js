var _                   = require('underscore');
var util                = require('util');
var http                = require('http');
var https               = require('https');
var fs                  = require('fs');
var url                 = require('url');
var path                = require('path');
var websocket           = require('websocket');

var logio               = require('./logio');
var VjsDbs              = require('./VjsDbs');
var Auth                = require('./Auth');
var Provider            = require('./Provider');
var Topology            = require('./Topology');
var Safety              = require('./Safety');
var Image               = require('./Image');
var WebSocketServer     = require('./WebSocketServer');

/*
*/

exports.WebServer = WebServer;
exports.setVerbose = function(v) { verbose = v; };

// ======================================================================

var verbose = 1;

function WebServer() {
  var webServer = this;
  webServer.urlProviders = {};
  webServer.dirProviders = {};
  webServer.wsHandlers = {};
  webServer.serverAccessCounts = {};
  webServer.wwwRoot = null;
  webServer.allConsoleHandlers = [];
}

WebServer.prototype.setUrl = function(url, p) {
  var webServer = this;
  if (_.isString(p)) {
    var st = fs.statSync(p);
    if (st.isDirectory()) {
      url = path.join(url, '/'); // ensure trailing slash, but doesn't yield more than one
      p = new Provider.RawDirProvider(p);
      webServer.dirProviders['GET ' + url] = p; 
    } else {
      p = new Provider.RawFileProvider(p);
    }
  }

  p.reloadKey = url;
  webServer.urlProviders['GET ' + url] = p; 
  p.on('changed', function() {
    if (p.reloadKey) {
      webServer.reloadAllBrowsers(p.reloadKey);
    }
  });
};

WebServer.prototype.setSocketProtocol = function(url, f) {
  var webServer = this;
  
  webServer.wsHandlers[url] = f;
};


WebServer.prototype.setupBaseProvider = function() {
  var webServer = this;

  if (webServer.baseProvider) return;
  var p = new Provider.ProviderSet();
  if (1) p.addCss(require.resolve('./common.css'));
  if (1) p.addCss(require.resolve('./spinner-lib/spinner.css'));
  // Add more CSS files here

  if (1) p.addScript(require.resolve('./VjsPreamble.js'));
  if (1) p.addScript(require.resolve('underscore'), 'underscore');
  if (1) p.addScript(require.resolve('../common/MoreUnderscore.js'));
  if (1) p.addScript(require.resolve('eventemitter'));
  if (1) p.addScript(require.resolve('./jquery/dist/jquery.js'));
  if (1) p.addScript(require.resolve('./ajaxupload-lib/ajaxUpload.js'));       // http://valums.com/ajax-upload/
  if (0) p.addScript(require.resolve('./swf-lib/swfobject.js'));               // http://blog.deconcept.com/swfobject/
  if (1) p.addScript(require.resolve('./mixpanel-lib/mixpanel.js'));
  if (1) p.addScript(require.resolve('./WebSocketHelper.js'), 'WebSocketHelper');
  if (1) p.addScript(require.resolve('./WebSocketBrowser.js'), 'WebSocketBrowser');
  if (1) p.addScript(require.resolve('./VjsBrowser.js'));

  webServer.baseProvider = p;
};

WebServer.prototype.setupInternalUrls = function() {
  var webServer = this;

  // WRITEME: ditch this, figure out how to upload over a websocket
  if (0) {
    webServer.urlProviders['POST /uploadImage'] = {
      start: function() {},
      mirrorTo: function(dst) {},
      handleRequest: function(req, res, suffix) {
        RpcEngines.UploadHandler(req, res, function(docFn, doneCb) {
          var userName = RpcEngines.cookieUserName(req);
          Image.mkImageVersions(docFn, {fullName: userName}, function(ii) {
            doneCb(ii);
          });
        });
      }
    };
  }

  webServer.setSocketProtocol('/console', webServer.mkConsoleHandler.bind(webServer));

  // Files available from root of file server
  webServer.setUrl('/favicon.ico', require.resolve('./images/vjs.ico'));
  webServer.setUrl('/spinner-lib/spinner.gif', require.resolve('./spinner-lib/spinner.gif'));
};

WebServer.prototype.setupContent = function(dirs) {
  var webServer = this;
  
  webServer.setupBaseProvider();
  webServer.setupInternalUrls();

  _.each(dirs, function(dir) {
    require('../../' + dir + '/load').load(webServer);
  });

  webServer.startAllContent();
  webServer.mirrorAll();
};



WebServer.prototype.startAllContent = function() {
  var webServer = this;
  _.each(webServer.urlProviders, function(p, name) {
    if (p.start) p.start();
  });
};

WebServer.prototype.mirrorAll = function() {
  var webServer = this;

  if (webServer.wwwRoot) {
    _.each(webServer.urlProviders, function(p, name) {
      var m = /^GET (.*)$/.exec(name);
      if (m) {
        var dst = path.join(webServer.wwwRoot, m[1]);
        p.mirrorTo(dst);
      }
    });
  }
};

WebServer.prototype.startHttpServer = function(port, bindHost) {
  var webServer = this;
  if (!port) port = 8000;
  if (!bindHost) bindHost = '127.0.0.1';
  
  webServer.httpServer = http.createServer(httpHandler);
  util.puts('Listening on ' + bindHost + ':' + port);
  webServer.httpServer.listen(port, bindHost);

  webServer.ws = new websocket.server({httpServer: webServer.httpServer});
  webServer.ws.on('request', wsRequestHandler);

  function httpHandler(req, res) {

    var up;
    try {
      up = url.parse(req.url, true);
    } catch (ex) {
      logio.E('http', 'Error parsing' + req.url, ex);
      return Provider.emit404(res, 'Invalid url');
    }

    var remote = req.connection.remoteAddress + '!http';
    
    if (!up.host) up.host = req.headers['host'];
    if (!up.host) up.host = 'localhost';
    if (up.host.match(/[^-\w\.\/\:]/)) {
      return Provider.emit404(res, 'Invalid host header');
    }

    var pathc = up.pathname.substr(1).split('/');
    if (pathc[0] === 'live') {
      pathc.shift();
    }
    var callid = req.method + ' /' + pathc.join('/');
    webServer.serverAccessCounts[callid] = (webServer.serverAccessCounts[callid] || 0) + 1;
    if (webServer.urlProviders[callid]) {
      logio.I('http', callid);
      webServer.urlProviders[callid].handleRequest(req, res, '');
      return;
    }

    for (var pathcPrefix = pathc.length-1; pathcPrefix >= 1; pathcPrefix--) {
      var prefix = req.method + ' /' + pathc.slice(0, pathcPrefix).join('/') + '/';
      if (webServer.dirProviders[prefix]) { 
        var suffix = pathc.slice(pathcPrefix, pathc.length).join('/');
        logio.I('http', prefix, suffix);
        webServer.dirProviders[prefix].handleRequest(req, res, suffix);
        return;
      }
    }

    logio.E(remote, '404 ' + callid);
    Provider.emit404(res, callid);
    return;
  }

  function wsRequestHandler(wsr) {
    var callid = wsr.resource;
    
    var handlersFunc = webServer.wsHandlers[callid];
    if (!handlersFunc) {
      logio.E('ws', 'Unknown api', callid);
      wsr.reject();
      return;
    }

    if (0) {     // WRITEME: check origin
      wsr.reject();
      return;
    }

    var wsc = wsr.accept(null, wsr.origin);
    if (!wsc) {
      logio.E('wsr.accept failed');
      return;
    }

    var handlers = handlersFunc();
    WebSocketServer.mkWebSocketRpc(wsr, wsc, handlers);
  }
};

WebServer.prototype.getSiteHits = function(cb) {
  var webServer = this;
  cb(_.map(_.sortBy(_.keys(webServer.serverAccessCounts), _.identity), function(k) {
    return {desc: 'http.' + k, hits: webServer.serverAccessCounts[k]};
  }));
};

WebServer.prototype.getContentStats = function(cb) {
  var webServer = this;
  cb(_.map(_.sortBy(_.keys(webServer.urlProviders), _.identity), function(k) { 
    return _.extend({}, webServer.urlProviders[k].getStats(), {desc: k});
  }));
};

WebServer.prototype.reloadAllBrowsers = function(reloadKey) {
  var webServer = this;
  _.each(webServer.allConsoleHandlers, function(ch) {
    if (ch.reloadKey === reloadKey) {
      ch.tx({cmd: 'reload'});
    }
  });
};

WebServer.prototype.mkConsoleHandler = function() {
  var webServer = this;
  return {
    start: function() {
      logio.I(this.label, 'Console started');
      webServer.allConsoleHandlers.push(this);
    },
    close: function() {
      var self = this;
      webServer.allConsoleHandlers = _.filter(webServer.allConsoleHandlers, function(other) { return other !== self; });
    },
    cmd_errlog: function(msg) {
      logio.E(this.label, 'Errors in ' + msg.ua);
      var err = msg.err;
      if (err) {
        if (_.isObject(err)) {
          err = util.inspect(err);
        }
        util.puts(err.replace(/^/mg, '    '));
      }
    },
    cmd_reloadOn: function(msg) {
      this.reloadKey = msg.reloadKey;
    }
  };
}
