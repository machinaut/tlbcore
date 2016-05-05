var _ = require('underscore');
var child_process = require('child_process');
var logio = require('../web/logio');

exports.ChildJsonPipe = ChildJsonPipe;
exports.setupJsonIn = setupJsonIn;

function ChildJsonPipe(execName, execArgs, execOptions) {
  var m = this;

  var child = child_process.spawn(execName, execArgs, _.extend({stdio: ['pipe', 'pipe', 'inherit']}, execOptions));

  m.child = child;
  m.queue = [];
  var datas=[];
  m.child.stdout.on('data', function(buf) {
    while (buf.length) {
      var eol = buf.indexOf(10); // newline
      if (eol < 0) {
        datas.push(buf);
        return;
      } else {
        datas.push(buf.slice(0, eol));
        var rep = JSON.parse(datas.join(''));
        datas = [];
        var repCb = m.queue.shift();
        repCb.apply(null, rep);
        buf = buf.slice(eol+1);
      }
    }
  });
  m.child.on('close', function(code, signal) {
    logio.I('child', 'close, code=', code, 'signal=', signal);
    m.child = null;
  });
}

ChildJsonPipe.prototype.rpc = function(req, repCb) {
  var m = this;
  m.queue.push(repCb);
  m.child.stdin.write(JSON.stringify(req));
  m.child.stdin.write('\n');
}


function setupJsonIn(stream, cb) {
  var datas=[];
  stream.on('data', function(buf) {
    while (buf.length) {
      var eol = buf.indexOf(10); // newline
      if (eol < 0) {
        datas.push(buf);
        return;
      } else {
        datas.push(buf.slice(0, eol));
        var rep = JSON.parse(datas.join(''));
        datas = [];
        cb(null, rep);
        buf = buf.slice(eol+1);
      }
    }
  });
}
