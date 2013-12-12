var _                   = require('underscore');
var WebSocketBrowser    = require('WebSocketBrowser');

/*
*/

$.action = {};
$.enhance = {};
$.allContent = {};

var Safety = {
  isValidServerName: function(serverName) {
    if (!(/^[\w_\.]+$/.test(serverName))) return false;
    if (serverName === 'all') return false;
    return true;
  },

  isValidToken: function(token) {
    if (!(/^[\w_]+$/.test(token))) return false;
    if (token.length < 3 || token.length > 128) return false;
    return true;
  },

  isValidUserName: function(userName) {
    if (!(/^[-a-z0-9\~\!\$\%\^\&\*_\=\+\}\{\'\?]+(\.[-a-z0-9\~\!\$\%\^\&\*_\=\+\}\{\'\?]+)*@([a-z0-9_][-a-z0-9_]*(\.[-a-z0-9_]+)*\.(aero|arpa|biz|com|coop|edu|gov|info|int|mil|museum|name|net|org|pro|travel|mobi|[a-z][a-z])|([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}))$/i.test(userName))) {
      return false;
    }
    return true;
  }
};

function gotoHash(hash, e) {
  var action, rc;

  if (hash === '') {
    action = $.action.front;
    if (action) {
      try {
        rc = action.call($(document.body), e, '');
      } catch(ex) {
        errlog('action', {hash: hash}, ex);
        return;
      }
      if (rc === false) {
        if (e) {
          e.stopPropagation();
          e.preventDefault();
        }
        gotoHash.activeHash = getLocationHash();
        return;
      }
    }
  }

  // Try every prefix of hash (including hash itself) starting with the longest until we find something
  for (var i=hash.length; i > 0; i--) {
    action = $.action[hash.substr(0, i)];
    if (action) {
      try {
        rc = action.call($(document.body), e, hash.substr(i));
      } catch(ex) {
        errlog('action', {hash: hash}, ex);
        return;
      }
      if (rc === false) {
        if (e) {
          e.stopPropagation();
          e.preventDefault();
        }
        gotoHash.activeHash = getLocationHash();
        return;
      }
    }
  }

  $.fn.setHash(hash);
  errlog('hashNotFound', {hash: hash});
  $(document.body).pageNotFound();
}

function historyPoll() {
  var curHash = getLocationHash();
  if (!(curHash === gotoHash.activeHash)) {
    if (console) console.log(gotoHash.activeHash + ' -> ' + curHash);
    gotoHash(curHash, null);
  }
}

function startHistoryPoll() {
  window.onpopstate = historyPoll;
  setInterval(historyPoll, 300);
}

function getLocationHash() {
  var h = window.location.hash;
  if (h.length) {
    return decodeURIComponent(h.substr(1));
  }
  return "";
}

$.fn.setHash = function(h) {
  // set activeHash first, since setting window.location.hash triggets a callback
  gotoHash.activeHash = h;
  window.location.hash = '#' + encodeURIComponent(h);
  return this;
};

$.fn.pageNotFound = function(o) {
  document.title = 'Not Found';
  this.html('<h3>Not Found</h3>');
};



/* ----------------------------------------------------------------------
   Content enhancers -- things that recognize magical constructions in the xml and add functionality
   
   $.enhance['selector'] = function() {  }
   creates an enhancer that matches on the given selector and calls the function with this bound to the jQuery wrapper on the elements
   
*/

$.defContent = function(contentName, contents) {
  $.allContent[contentName] = contents;
};

$.fn.fmtContent = function(contentName) {
  if ($.allContent[contentName]) {
    this.html($.allContent[contentName]);
  } else {
    this.html(contentName);
  }
  this.enhance();
};

$.fn.enhance = function() {
  for (var k in $.enhance) {
    if ($.enhance.hasOwnProperty(k)) {
      var el = this.find(k);
      if (el.length) {
        $.enhance[k].call(el);
      }
    }
  }
};

$.enhance['div.includeContent'] = function() {
  var contentName = this.data('name');
  this.fmtContent(contentName);
};

/* ----------------------------------------------------------------------
  DOM utility functions
*/

$.simplePage = function(name, renderFunc) {

  var fullfn = 'page_' + name;

  $.action[name] = function(o) {
    this[fullfn](o);
    return false;
  };
  $.fn[fullfn] = renderFunc;
};

$.fn.exec = function(f, a, b, c, d, e) {
  // I believe this is faster than doing slice(arguments)
  f.call(this, a, b, c, d, e);
  return this;
};

$.fn.formSetExamples = function(options) {
  var f = this;
  this.find('.formHint').hide();
  // Note: you must include 'type="text"' in the tag, even though it's the default
  this.find('input[type="text"]').add('textarea').each(function(index, input) {
    input = $(input);
    if (input.val() === '') {

      if (input.attr('example') && !input.hasClass('inputChanged')) {
        input.addClass('inputExample');
        input.val(input.attr('example'));
      }

      input.bind('focus', function(e) {
        if (input.attr('example') && input.val() === input.attr('example') && !input.hasClass('inputChanged')) {
          input.val('');
          input.removeClass('inputError inputExample');
        }
        input.addClass('inputChanged');
        f.find('.formHint').hide();
        input.closest('tr,*').find('.formHint').show();
      });

      input.bind('mouseover', function(e) {
        f.find('.formHint').hide();
        input.closest('tr,*').find('.formHint').show();
      });

      input.bind('blur', function(e) {
        input.closest('tr,*').find('.formHint').hide();
        if (input.val() === '' && input.attr('example') && input.hasClass('inputChanged')) {
          input.addClass('inputExample');
          input.val(input.attr('example'));
        }
      });

      input.bind('mouseout', function(e) {
        input.closest('tr,*').find('.formHint').hide();
      });

      input.bind('keypress', function(e) {
        input.addClass('inputChanged');
      });
    }
  });
  return this;
};

$.fn.formClearExamples = function() {
  this.find('.inputExample').val('').removeClass('inputExample');
  return this;
};

$.fn.formEnableSubmits = function() {
  this.find("input[type=submit]").attr('disabled', false);
  return this;
};

$.fn.formDisableSubmits = function() {
  this.find("input[type=submit]").attr('disabled', true);
  return this;
};

$.fn.formEnableAll = function() {
  this.find(':input').attr('disabled', false);
};

$.fn.formDisableAll = function() {
  this.find(':input').attr('disabled', true);
};

$.fn.formClearReds = function() {
  this.find('input[type=text]').css({backgroundColor: '#ffffff'});
  this.find('input').removeClass('inputError');
  return this;
};

/*
  Set value of a form field. Don't change if it has the inputChanged field set (which we set elsewhere when the field is edited)
  If it's a textarea with the 'autoExpand' class, adjust the size to fit
*/
$.fn.utVal = function(value) {
  if (!this.hasClass('inputChanged')) {
    this.val(value);
    if (this.length === 1 && this.hasClass('autoExpand')) {
      var nl = value.split('\n').length + 3;
      nl = Math.max(nl, this.attr('rows') || 5);
      this.attr({rows: nl.toString()});
    }
  }
  return this;
};

/*
  Set the inputError class on a form input, makes it red
*/
$.fn.inputSetRed = function() {
  this.addClass('inputError');
  return this;
};

/*
  Remove any spinners from inside this element
*/
$.fn.clearSpinner = function() {
  this.find('.spinner320x240').add('.spinner24x24').add('.spinner160x120').remove();
  return this;
};

/*
  Take a list of items, turn into <ul><li>...</ul>
*/
$.fn.fmtBullets = function(items) {
  this.html('<ul>' +
            _.map(items, function(item) {
              return '<li>' + item + '</li>';
            }) + '</ul>');
  return this;
};

/* ----------------------------------------------------------------------
  Set text, escaping potential html
*/
$.fn.fmtText = function(text) {  
  this.html(text.toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  return this;
};

$.fn.fmtTextLines = function(text) {  
  this.html(text.toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>'));
  return this;
};

$.fn.fmtException = function(ex) {
  this.fmtTextLines(ex.stack || ex.message);
  return this;
};

// Take a list of items or a string with \ns, turn into lines separated by <br>
$.fn.fmtLines = function(l) {
  if (_.isArray(l)) {
    this.html(l.join('<br/>'));
  }
  else if (_.isString(l)) {
    this.html(l.replace(/\n/g, '<br/>'));
  }
  else if (l) {
    this.html(l.toString().replace(/\n/g, '<br/>'));
  }
  return this;
};

$.fn.wrapInnerLink = function(url) {
  this.wrapInner('<a href="' + url + '">');
  return this;
};


/* ----------------------------------------------------------------------
   Format dates
*/

$.fn.fmtShortDate = function(d) {
  if (_.isNumber(d)) d = new Date(d);
  function pad(n) {
    if (n < 10) return '0'+n.toFixed();
    return n.toFixed();
  }
  this.html(d.getFullYear() + '.' + 
            (d.getMonth()+1).toFixed() + '.' +
            d.getDate().toFixed() + ' ' +
            d.getHours() + ':' + 
            pad(d.getMinutes()) + ':' +
            pad(d.getSeconds()));
  return this;
};

$.fn.fmtTimeSince = function(lastUpdate) {
  
  if (!lastUpdate || isNaN(lastUpdate)) {
    this.html('unknown');
    return this;
  }
  var seconds = realtime() - lastUpdate;
  if (seconds < 0) seconds = 1;
  this.fmtTimeInterval(seconds);
};

$.fn.fmtTimeInterval = function(seconds) {
  if (!_.isNumber(seconds)) {
    return this.html('');
  }
  seconds = Math.floor(seconds);

  if (seconds < 100) {
    return this.html(seconds.toString() + 's');
  }

  var minutes = (seconds - (seconds % 60)) / 60;
  if (minutes < 100) {
    return this.html(minutes.toString() + 'm');
  }
  var hours = (minutes - (minutes % 60)) / 60;
  minutes = minutes % 60;
  if (hours < 24) {
    return this.html(hours.toString() + 'h ' + minutes.toString() + 'm');
  }
  var days = (hours - (hours % 24)) /24;
  hours = hours % 24;
  return this.html(days.toString() + 'd ' + hours.toString() + 'h ' + minutes.toString() + 'm');
};


/* ----------------------------------------------------------------------
   Format error messages
*/
$.fn.fmtErrorMessage = function(err) {
  this.clearSpinner();
  this.clearSuccessMessage();

  var em = this.find('.errorMessage').last();
  if (!em.length) em = this.find('.errorBox');
  if (!em.length) {
    em = $('<span class="errorMessage">');
    var eml = this.find('.errorMessageLoc');
    if (eml.length) {
      eml.append(em);
    } else {
      this.append(em);
    }
  }
  
  if (_.isString(err)) {
    em.html(err);
  }
  else if (!err) {
    em.html('');
  }
  else {
    em.html('Unknown error ' + err.result);
  }
  em.show();
  return em;
};

$.fn.clearErrorMessage = function() {
  this.find('.errorMessage').hide();
  this.find('.errorMessageLoc').empty().hide();
  return this;
};

$.fn.fmtSuccessMessage = function(msg, specials) {
  this.clearSpinner();
  this.clearErrorMessage();

  var sm = this.find('.successMessage');
  if (!sm.length) sm = this.find('.successBox');
  if (!sm) {
    sm = $('span class="successMessage">');
    this.append('<br/>').append(sm);
  }

  if (_.isString(msg)) {
    sm.html(msg);
  }
  else if (specials && specials.hasOwnProperty(msg.result)) {
    sm.html('Success! <span class="successMessageBlack">' + specials[msg.result] + '</span>');
  }
  else {
    sm.html('Success! ' + msg.result);
  }
  sm.show();
  return sm;
};

$.fn.clearSuccessMessage = function() {
  this.find('.successMessage').empty();
  return this;
};

var flashErrorMessageTimeout = null;

$.flashErrorMessage = function(msg) {
  var fem = $('#flashErrorMessage');
  if (fem.length === 0) {
    fem = $('<div id="flashErrorMessage">').appendTo(document.body);
    var sw = $(window).width();
    var fw = fem.width();
    fem.css({left: Math.floor((sw-fw)/2 - 30).toString() + 'px'});
  }
  var em = $('<div class="errorMessage">');
  fem.append(em).show();
  fem.fmtErrorMessage(msg);
  if (flashErrorMessageTimeout) {
    clearTimeout(flashErrorMessageTimeout);
  }
  flashErrorMessageTimeout = setTimeout(function() {
    fem.effect('fade', 500, function() {
      fem.empty();
    });
  }, 2000);
};

/* ----------------------------------------------------------------------
  DOM structure utilities
*/

$.fn.findOrCreate = function(sel, constructor) {
  var findSel = this.find(sel);
  if (findSel.length) {
    return findSel;
  } else {
    this.append(constructor);
    return this.find(sel);
  }
};

$.fn.toplevel = function() {
  return this.closest('body'); // might change when we have sub-panels
};


$.fn.syncChildren = function(newItems, options) {
  if (this.length === 0) return;
  if (this.length > 1) return this.first().syncChildren(newItems, options);

  var domKey = options.domKey || 'syncDomChildren';
  var domClass = options.domClass || 'syncDomChildren';
  
  var removeEl = options.removeEl || function(name) {
    this.effect('fadeOut', 500, function() { $(this).remove(); });
  };
  var createEl = options.createEl || function(name) {
    return $('<div class="' + domClass + '">');
  };
  var setupEl = options.setupEl || function() {
  };
  var updateEl = options.updateEl || function() {
  };

  // Find all contained dom elements with domClass, index them by domKey
  var oldEls = {};

  _.each(this.children(), function(oldEl) {
    var name = $(oldEl).data(domKey);
    if (name !== undefined) {
      oldEls[name] = oldEl;
    }
  });

  // Index newItems by name
  var itemToIndex = {};
  _.each(newItems, function(name, itemi) {
    itemToIndex[name] = itemi;
  });

  // Remove orphaned elems (in oldEls but not in itemToIndex)
  _.each(oldEls, function(name) {
    if (!itemToIndex.hasOwnProperty(name)) {
      removeEl.call($(oldEls[name]), name);
    }
  });

  // Insert new elems into dom
  var afterEl = null;
  _.each(newItems, function(name, itemi) {
    if (oldEls.hasOwnProperty(name)) {
      afterEl = oldEls[name];
    } else {
      var newEl = createEl(name);
      if (!newEl) return;
      if (newEl.length) newEl = newEl[0]; // unwrap if already wrapped in jquery
      $(newEl).data(domKey, name);
      oldEls[name] = newEl;
      if (afterEl) {
        $(afterEl).after(newEl);
        afterEl = newEl;
      } else {
        this.prepend(newEl);
        afterEl = newEl;
      }
      setupEl.call($(newEl), name);
    }
    /*
      If calcSignature is supplied, we use it to avoid updates when nothing has changed.
      It should be a signature across everything that matters for the content
    */
    if (options.calcSignature) {
      var signature = options.calcSignature(name);
      var oldSignature = $(oldEls[name]).attr('signature');
      if (signature != oldSignature) {
        $(oldEls[name]).attr('signature', signature);
        updateEl.call($(oldEls[name]), name);
      }
    } else {
      updateEl.call($(oldEls[name]), name);
    }
  });

  // Return map of old & new elements
  return oldEls;
};


/* ----------------------------------------------------------------------
  Animation
*/

// Polyfill for browsers with no requestAnimationFrame
(function() {
  var lastTime = 0;
  var vendors = ['ms', 'moz', 'webkit', 'o'];
  for (var x = 0; x < vendors.length && !window.requestAnimationFrame; ++x) {
    window.requestAnimationFrame = window[vendors[x]+'RequestAnimationFrame'];
    window.cancelAnimationFrame = 
      window[vendors[x]+'CancelAnimationFrame'] || window[vendors[x]+'CancelRequestAnimationFrame'];
  }
  
  if (!window.requestAnimationFrame)
    window.requestAnimationFrame = function(callback, element) {
      var currTime = new Date().getTime();
      var timeToCall = Math.max(0, 16 - (currTime - lastTime));
      var id = window.setTimeout(function() { callback(currTime + timeToCall); }, 
                                 timeToCall);
      lastTime = currTime + timeToCall;
      return id;
    };
  
  if (!window.cancelAnimationFrame)
    window.cancelAnimationFrame = function(id) {
      clearTimeout(id);
    };
}());

$.fn.animation = function(f, deltat) {
  var self = this;
  window.requestAnimationFrame(wrap);
  var lasttick = 0;
  if (!deltat) deltat = 1;
  var maxTicks = Math.max(5, (100 / deltat));

  function wrap(curtime) {
    // Make sure dom object still exists, otherwise give up
    if (self.closest('body').length) {
      var curtick = Math.floor(curtime / deltat);
      
      var nticks = 0;
      if (curtick <= lasttick) {
      }
      else if (curtick - lasttick >= maxTicks) {
        nticks = maxTicks;
      }
      else {
        nticks = curtick - lasttick;
      }
      lasttick = curtick;

      if (nticks > 0) {
        f.call(self, nticks);
      }
      window.requestAnimationFrame(wrap);
    } else {
      if (console) console.log(self, 'disconnected');
    }
  }
};

/* ----------------------------------------------------------------------
   Track all key events within a document object. The hash (down) keeps track of what keys are down, 
   and (changed) is called whenever anything changes.
*/

$.fn.trackKeys = function(down, changed) {
  $(window).on('keydown', function(ev) {
    var keyChar = String.fromCharCode(ev.which);
    down[keyChar] = true;
    if (changed) changed();
  });
  $(window).on('keyup', function(ev) {
    var keyChar = String.fromCharCode(ev.which);
    down[keyChar] = false;
    if (changed) changed();
  });
};

/* ----------------------------------------------------------------------
  On some browsers on retina devices, the canvas is at css pixel resolution. 
  This converts it to device pixel resolution.
*/
$.fn.maximizeCanvasResolution = function() {
  this.find('canvas').each(function(index, canvas) {
    var ctx = canvas.getContext('2d');
    var devicePixelRatio = window.devicePixelRatio || 1;
    var backingStoreRatio = (ctx.webkitBackingStorePixelRatio || ctx.mozBackingStorePixelRatio || ctx.msBackingStorePixelRatio ||
                             ctx.oBackingStorePixelRatio || ctx.backingStorePixelRatio || 1);
    if (devicePixelRatio !== backingStoreRatio) {
      var ratio = devicePixelRatio / backingStoreRatio;
      var oldWidth = canvas.width;
      var oldHeight = canvas.height;
      
      canvas.pixelRatio = ratio;

      canvas.width = oldWidth * ratio;
      canvas.height = oldHeight * ratio;

      canvas.style.width = oldWidth + 'px';
      canvas.style.height = oldHeight + 'px';
    }
  });
  return this;
};

function mkImage(src, width, height) {
  var ret = new Image();
  ret.src = src;
  ret.width = width;
  ret.height = height;
  return ret;
}


/* ----------------------------------------------------------------------
   Console
*/

function setupConsole(reloadKey) {
  // Gracefully degrade firebug logging
  function donothing () {}
  if (!window.console) {
    var names = ['log', 'debug', 'info', 'warn', 'error', 'assert', 'dir', 'dirxml', 'group', 
                 'groupEnd', 'time', 'timeEnd', 'count', 'trace', 'profile', 'profileEnd'];
    window.console = {};
    for (var i = 0; i<names.length; i++) window.console[names[i]] = donothing;
  }

  // Create remote console over a websocket connection
  window.rconsole = mkWebSocket('console', {
    start: function() {
      if (reloadKey) {
        // Ask the server to tell us to reload. Look for reloadKey in VjsSite.js for the control flow.
        this.tx({cmd: 'reloadOn', reloadKey: reloadKey});
      }
    },
    cmd_reload: function(msg) { // server is asking us to reload, because it knows that javascript files have changed
      console.log('Reload');
      window.location.reload(true);
    },
    cmd_flashError: function(msg) {
      $(document.body).flashErrorMessage(msg.err);
    }
  });
}

/*
  Log an error or warning to the browser developer console and the web server, through the websocket connection to /console
*/
function errlog() {
  // console.log isn't a function in IE8
  if (console && _.isFunction(console.log)) console.log.apply(console, arguments);
  if (window.rconsole) {
    var stack = '';
    var err = '';
    var sep = '';
    for (var i=0; i<arguments.length; i++) {
      var arg = arguments[i];
      if (arg) {
        if (_.isObject(arg)) {
          err += sep + JSON.stringify(arg);
          if (arg.stack) {
            stack = arg.stack;
            if (console && _.isFunction(console.log)) console.log(stack);
          }
        }
        else {
          try {
            err += sep + arg.toString();
          } catch(ex) {
            err += sep + 'toString fail\n';
          }
        }
        sep = ' ';
      }
    }
    if (stack) err += '\n' + stack.toString();

    window.rconsole.tx({cmd: 'errlog', err: err, ua: navigator.userAgent});
  }
}

/* ----------------------------------------------------------------------
   Session & URL management
*/

function setupClicks() {
  $(document.body).bind('click', function(e) {
    var closestA = $(e.target).closest('a');
    if (closestA.length) {
      var href = closestA.attr('href');
      if (console) console.log('click a href ' + href);
      if (href && href.substr(0,1) === '#') {
        gotoHash(href.substr(1), e);
        return false;
      }
      // WRITEME: add special click handlers
    }
  });
}


/* ----------------------------------------------------------------------
  Interface to Mixpanel.
*/

function setupMixpanel() {
  try {
    var mpkey = null, mpid = null;
    // WRITEME: add mixpanel key here
    if (0 && window.anyCloudHost === 'localhost') {
      mpkey = 'dd77bca94d9b6ade709f734c3026b305';   // Devel
      mpid = '3923';
    }
    if (mpkey) {
      window.mpmetrics = new window.MixpanelLib(mpkey);
      window.mpmetrics.statsUrl = 'http://mixpanel.com/report/' + mpid + '/';
    }
  } catch(ex) {
    errlog('setupMixpanel', ex);
  }
};



/* ----------------------------------------------------------------------
   Web Sockets
*/

function mkWebSocket(path, handlers) {
  var host = window.location.host;
  var protocol = window.location.protocol;
  var wsUrl = ((protocol === 'https') ? 'wss' : 'ws') + '://' + host + '/' + path;
  // WRITEME: detect vendor-prefixed WebSocket.
  // WRITEME: Give some appropriately dire error message if websocket not found or fails to connect
  var wsc = new WebSocket(wsUrl);
  return WebSocketBrowser.mkWebSocketRpc(wsc, handlers);
};

/* ----------------------------------------------------------------------
   Called from web page setup code (search for pageSetupFromHash in Provider.js)
*/

function pageSetupFromHash(reloadKey) {
  setupConsole(reloadKey);
  setupClicks();
  gotoHash(getLocationHash(), null);
  startHistoryPoll();
}
