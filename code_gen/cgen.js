'use strict';
var os                  = require('os');
var fs                  = require('fs');
var util                = require('util');
var assert              = require('assert');
var _                   = require('underscore');
require('../common/MoreUnderscore');

exports.FileGen = FileGen;
exports.escapeCString = escapeCString;
exports.escapeCJson = escapeCJson;

function escapeCString(s) {
  return s.replace(/[\000-\040\\"\'|]/g, "\\$&");
}

function escapeCJson(o) {
  var oStr = JSON.stringify(o);
  var oStrLen = oStr.length;
  var cStrings = ['""'];
  var chunk = 80;
  for (var i=0; i<oStrLen; i+= chunk) {
    cStrings.push('"' + escapeCString(oStr.substr(i, chunk)) + '"');
  }
  return cStrings.join('\n    ');
}

function mkCodeGen(filename, subs) {
  var contents = [];
  var subsPattern = new RegExp('(' + _.map(_.keys(subs), _.requote).join('|') + ')', 'g');

  function line(code) {
    if (_.isFunction(code)) {
      return code(line);
    }
    if (/(WARNING|ERROR)/.test(code)) {
      util.puts(code);
    }

    code = code.replace(subsPattern, function(m) {
      if (m in subs) {
        return subs[m];
      } else {
        return m;
      }
    });

    contents.push(code.trim() + '\n');
  }

  function expandContents(dst) {
    _.each(contents, function(c) {
      if (c.expandContents) {
        c.expandContents(dst);
      } else {
        dst.push(c);
      }
    });
  }

  function end() {
    var expContents = [];
    expandContents(expContents);

    if (/\.(c|cc|cpp|h|js)$/.exec(filename)) {
      cIndent(expContents);
    }
    if (/\.h$/.exec(filename)) {
      hProtect(expContents);
    }

    var expContentsStr = expContents.join('');
    if (fs.existsSync(filename)) {
      var text1 = fs.readFileSync(filename, 'utf8');
      if (withoutGeneratedLine(text1) === expContentsStr) {
        return;
      }
    }

    var fullContentsStr;
    if (/\.gypi$/.exec(filename)) {
      fullContentsStr = expContentsStr;
    } else {
      fullContentsStr = '/* Generated by ' + process.argv.join(' ') + ' at ' + (new Date().toUTCString()) + ' */\n' + expContentsStr;
    }
    
    fs.writeFileSync(filename, fullContentsStr, 'utf8');
    util.puts('Wrote ' + filename);
  }
  
  function hProtect(expContents) {
    var hpsym = 'INCLUDE_' + filename.replace(/[^a-zA-Z0-9]+/g, '_');
    expContents.unshift('#define ' + hpsym + '\n');
    expContents.unshift('#ifndef ' + hpsym + '\n');
    expContents.push('#endif\n');
  }

  function cIndent(expContents) {
    var braceLevel = 0;
    var parenLevel = 0;
    var spaces = '                                                                                ';
    for (var ci=0; ci < expContents.length; ci++) {
      var l = expContents[ci];

      var ll = l.length;
      if (!(ll === 0 || l.charCodeAt(0) === 35)) {
        var minBraceLevel = braceLevel;
        var origParenLevel = parenLevel;
        var inDoubleQuote = false;
        var inSingleQuote = false;
        var inSingleLineComment = false;
        var escaped;
        var lastc = 0;
        for (var i = 0; i < ll; i++) {
          var c = l.charCodeAt(i);
          if (c === 92) {
            escaped = true;
            continue;
          }
          if (c === 34 && !escaped) inDoubleQuote = !inDoubleQuote;
          if (c === 39 && !escaped) inSingleQuote = !inSingleQuote;
          if (!inDoubleQuote && !inSingleQuote && !inSingleLineComment) {
            if (c === 47 && lastc === 47) inSingleLineComment = true;
            if (c === 123) braceLevel++;
            if (c === 125) {
              braceLevel--;
              minBraceLevel = braceLevel;
            }
            if (c === 40) parenLevel++;
            if (c === 41) parenLevel--;
          }
          escaped = false;
          lastc = c;
        }
        var indentLevel = minBraceLevel * 2 + origParenLevel * 4;
        if (l === '}\n' && indentLevel === 0) {
          l = l + '\n';
        }
        expContents[ci] = spaces.substr(0, indentLevel) + l;
      }
    }
  }

  function child(moreSubs) {
    var childSubs;
    if (moreSubs) {
      childSubs = _.extend(_.clone(subs), moreSubs);
    } else {
      childSubs = subs;
    }
    var ret = mkCodeGen(filename, childSubs);
    contents.push(ret);
    return ret;
  }

  line.expandContents = expandContents;
  line.end = end;
  line.child = child;
  
  return line;
}


function withoutGeneratedLine(t) {
  return t.replace(/\/\* Generated by .* \*\/\n/g, '');
}


// ----------------------------------------------------------------------

function FileGen(prefix) {
  this.prefix = prefix;
  this.files = {};
}

FileGen.prototype.getFile = function(name) {
  var fn = this.prefix + name;

  if (!(fn in this.files)) {
    this.files[fn] = mkCodeGen(fn, {FILENAME: name});
  }
  return this.files[fn];
};

FileGen.prototype.end = function() {
  _.each(this.files, function(cg) {
    cg.end();
  });
};


