'use strict';
/*
  This (called by mk_marshall.js) generates most of the stuff in the build.src directory.
  For each type it knows about, it generates the following files:
    
    TYPENAME_decl.h
      A C++ header defining the structure of each type

    TYPENAME_host.cc
      A C++ definition of the type. It has no nodejs dependencies so you can use it in a pure C++ program.
      It includes constructors, an << operator for printing, and marshalling/unmarshalling to JSON.
      The _host is a legacy of when we also had an _embedded version for microcontrollers
       
    TYPENAME_jsWrap.{h,cc}
      A wrapping of the type for nodejs. It depends on both nodejs and v8. 

    test_TYPENAME.js
      A Mocha test file, exercises the basics
       
*/
var _                   = require('underscore');
var assert              = require('assert');
var fs                  = require('fs');
var util                = require('util');
var crypto              = require('crypto');
var path                = require('path');
var cgen                = require('./cgen');
var gen_functions       = require('./gen_functions');

var debugJson = false;

exports.TypeRegistry = TypeRegistry;
exports.emitJsWrap = emitJsWrap;
exports.emitArgSwitch = emitArgSwitch;

function getTypename(t) {
  if (t.hasOwnProperty('typename')) {
    return t.typename;
  } else {
    return t;
  }
}

function sortTypes(types) {
  return _.uniq(_.sortBy(types, getTypename), true, getTypename);
}

function nonPtrTypes(types) {
  return _.map(types, function(t) { return t.nonPtrType(); });
}


function TypeRegistry(groupname) {
  var typereg = this;
  typereg.groupname = groupname;
  typereg.moduleToTypes = {};
  typereg.typeToModule = {};
  typereg.types = {};
  typereg.enums = [];
  typereg.consts = {};
  typereg.wrapFunctions = {};
  typereg.rtFunctions = {};
  typereg.extraJsWrapFuncsHeaders = [];

  typereg.setPrimitives();
}

TypeRegistry.prototype.scanJsDefn = function(fn) {
  var typereg = this;
  var scanModule = require(fs.realpathSync(fn));
  scanModule(typereg);
};

TypeRegistry.prototype.setPrimitives = function() {
  var typereg = this;
  typereg.types['void'] = new PrimitiveCType(typereg, 'void');
  typereg.types['bool'] = new PrimitiveCType(typereg, 'bool');
  typereg.types['float'] = new PrimitiveCType(typereg, 'float');
  typereg.types['double'] = new PrimitiveCType(typereg, 'double');
  typereg.types['arma::cx_double'] = new PrimitiveCType(typereg, 'arma::cx_double');
  typereg.types['int'] = new PrimitiveCType(typereg, 'int');
  typereg.types['u_int'] = new PrimitiveCType(typereg, 'u_int');
  typereg.types['string'] = new PrimitiveCType(typereg, 'string');
  typereg.types['jsonstr'] = new PrimitiveCType(typereg, 'jsonstr');
  if (1) {
    typereg.types['vector<jsonstr>'] = new CollectionCType(typereg, 'vector<jsonstr>');
    typereg.types['map<string,jsonstr>'] = new CollectionCType(typereg, 'map<string,jsonstr>');
  }
};

TypeRegistry.prototype.primitive = function(typename) {
  var typereg = this;
  if (typename in typereg.types) throw 'Already defined';
  var t = new PrimitiveCType(typereg, typename);
  typereg.types[typename] = t;
  return t;
};

TypeRegistry.prototype.object = function(typename) {
  var typereg = this;
  if (typename in typereg.types) throw 'Already defined';
  var t = new ObjectCType(typereg, typename);
  typereg.types[typename] = t;
  var ptrTypename = typename + '*';
  typereg.types[ptrTypename] = new PtrCType(typereg, t);
  return t;
};


TypeRegistry.prototype.struct = function(typename /* varargs */) {
  var typereg = this;
  if (typename in typereg.types) throw 'Already defined';
  var t = new StructCType(typereg, typename);
  typereg.types[typename] = t;
  var ptrTypename = typename + '*';
  typereg.types[ptrTypename] = new PtrCType(typereg, t);

  for (var i=1; i<arguments.length; i++) {
    var name = arguments[i][0];
    var type = arguments[i][1];
    t.add(name, type);
  }
  return t;
};

TypeRegistry.prototype.template = function(typename) {
  var typereg = this;
  if (typename in typereg.types) return typereg.types[typename];
  var t = new CollectionCType(typereg, typename);
  typereg.types[typename] = t;
  var ptrTypename = typename + '*';
  typereg.types[ptrTypename] = new PtrCType(typereg, t);
  return t;
};

TypeRegistry.prototype.getType = function(typename) {
  var typereg = this;
  if (typename === null || typename === undefined) return null;
  if (typename.typename) return typename; // already a type object
  return typereg.types[typename];
};

TypeRegistry.prototype.aliasType = function(existingName, newName) {
  var typereg = this;
  var type = typereg.getType(existingName);
  if (!type) throw 'No such type ' + existingName;
  typereg.types[newName] = type;
};

TypeRegistry.prototype.loadDeclarations = function(modulename) {
  // WRITEME
};

TypeRegistry.prototype.emitAll = function(files) {
  var typereg = this;

  _.each(typereg.types, function(type, typename) {
    if (type.typename !== typename) return;
    type.emitAll(files);
  });

  typereg.emitJsWrapFuncs(files);
  typereg.emitJsBoot(files);
  typereg.emitRtFunctions(files);
  typereg.emitGypFile(files);
  typereg.emitMochaFile(files);
  typereg.emitSchema(files);
};

TypeRegistry.prototype.emitJsBoot = function(files) {
  var typereg = this;
  var f = files.getFile('jsboot_' + typereg.groupname + '.cc');
  f('#include "tlbcore/common/std_headers.h"');
  f('#include "tlbcore/nodeif/jswrapbase.h"');
  _.each(typereg.types, function(type, typename) {
    if (type.typename !== typename) return;
    if (type.hasJsWrapper()) {
      f('void jsInit_' + type.jsTypename + '(Handle<Object> exports);');
    }
  });
  f('void jsInit_functions(Handle<Object> exports);');
  f('');
  var schemas = typereg.getSchemas();
  f('static Handle<Value> getSchemas() {');
  f('HandleScope scope;');
  // WRITEME: if this is a common thing, make a wrapper function
  f('Handle<Value> ret = Script::Compile(String::New("("' + cgen.escapeCJson(schemas) + '")"), String::New("binding:script"))->Run();');
  f('return scope.Close(ret);');
  f('}');
  f('');

  f('void jsBoot(Handle<Object> exports) {');
  _.each(typereg.types, function(type, typename) {
    if (type.typename !== typename) return;
    if (type.hasJsWrapper()) {
      f('jsInit_' + type.jsTypename + '(exports);');
    }
  });
  f('jsInit_functions(exports);');
  f('exports->Set(String::New("schemas"), getSchemas());');
  f('}');
  f.end();
};

TypeRegistry.prototype.emitJsWrapFuncs = function(files) {
  var typereg = this;
  var f = files.getFile('functions_' + typereg.groupname + '_jsWrap.cc');
  f('#include "tlbcore/common/std_headers.h"');
  f('#include "tlbcore/nodeif/jswrapbase.h"');
  f('#include "./rtfns_' + typereg.groupname + '.h"');
  _.each(typereg.extraJsWrapFuncsHeaders, f);
  _.each(typereg.types, function(type, typename) {
    if (type.typename !== typename) return;
    var fns = type.getFns();
    if (fns.jsWrapHeader) {
      f('#include "' + fns.jsWrapHeader + '"');
    }
  });
  f('');
  f('using namespace arma;');

  typereg.emitFunctionWrappers(f);
  f.end();
};

TypeRegistry.prototype.emitGypFile = function(files) {
  var typereg = this;
  var f = files.getFile('sources_' + typereg.groupname + '.gypi');
  f('{');
  f('"sources": [');
  _.each(typereg.types, function(type, typename) {
    if (type.typename !== typename) return;
    var fns = type.getFns();
    if (fns.hostCode) {
      f('\"' + fns.hostCode + '\",');
    }
    if (fns.jsWrapCode) {
      f('\"' + fns.jsWrapCode + '\",');
    }
  });
  f('\"' + 'jsboot_' + typereg.groupname + '.cc' + '\",');
  f('\"' + 'rtfns_' + typereg.groupname + '.cc' + '\",');
  f('\"' + 'functions_' + typereg.groupname + '_jsWrap.cc' + '\",');
  f(']');
  f('}');

};


TypeRegistry.prototype.emitMochaFile = function(files) {
  var typereg = this;
  var f = files.getFile('test_' + typereg.groupname + '.js');
  f('var _ = require("underscore");');
  f('var ur = require("ur");');
  f('var util = require("util");');
  f('var assert = require("assert");');
  
  _.each(typereg.types, function(type, typename) {
    if (type.typename !== typename) return;
    type.emitJsTestImpl(f.child({TYPENAME: type.typename, JSTYPE: type.jsTypename}));
    f('');
  });
};

/*
  Take a C function name, return JS. Only different in the case of operators
*/
function funcnameCToJs(name) {
  switch (name) {
  case 'operator+': return 'add';
  case 'operator-': return 'sub';
  case 'operator*': return 'mul';
  case 'operator/': return 'div';
  case 'operator>>': return 'rshift';
  case 'operator<<': return 'lshift';
  case 'operator==': return 'equals';
  default: return name;
  }
}

/*
  Return the expression to call a function with given arguments. 
*/
function getFunctionCallExpr(funcexpr, args) {
  /*
    It works fine to say foo = operator+(bar, buz) when bar and buz are structures and the operator + function is overloaded.
    But for native types, c++ only accepts infix notation.
  */
  var m = /^operator (\s+)/.exec(funcexpr);
  if (m && args.length === 2) {
    return args[0] + ' ' + m[1] + ' ' + args[1];
  }
  return funcexpr + '(' + args.join(', ') + ')';
}


TypeRegistry.prototype.emitFunctionWrappers = function(f) {
  var typereg = this;

  var initFuncs = [];

  _.each(typereg.wrapFunctions, function(funcInfos, jsFuncname) {

    var funcInfosByTemplate = {};
    _.each(funcInfos, function(funcInfo) {
      if (!funcInfosByTemplate[funcInfo.funcTemplate]) funcInfosByTemplate[funcInfo.funcTemplate] = [];
      funcInfosByTemplate[funcInfo.funcTemplate].push(funcInfo);
    });
    f('/* funcInfosByTemplate: ' + jsFuncname + '\n' + util.inspect(funcInfosByTemplate) + '\n*/');
    
    _.each(funcInfosByTemplate, function(funcInfosThisTemplate, funcTemplate) {
      var funcTemplateType = (funcTemplate !== '') ? typereg.getType(funcTemplate) : null;
      var jsScopedFuncname = jsFuncname + (funcTemplateType ? '_' + funcTemplateType.jsTypename : '');

      f('Handle<Value> jsWrap_' + jsScopedFuncname + '(Arguments const &args) {');
      f('HandleScope scope;');
      _.each(funcInfosThisTemplate, function(funcInfo) {
        f('// ' + funcInfo.desc);

        f('if (args.Length() == ' + funcInfo.args.length +
          _.map(funcInfo.args, function(argInfo, argi) {
            var argType = typereg.types[argInfo.typename];
            return ' && ' + argType.getJsToCppTest('args[' + argi + ']');
          }).join('') +
          ') {');

        var callargs = [];

        _.each(funcInfo.args, function(argInfo, argi) {
          var argType = typereg.types[argInfo.typename];
          f(argType.getArgTempDecl('a' + argi) + ' = ' + argType.getJsToCppExpr('args[' + argi + ']') + ';');
          callargs.push('a' + argi);
        });

        f('try {');
        if (funcInfo.returnType === 'void') {
          f(funcInfo.funcInvocation + '(' + callargs.join(', ') + ');');
          f('return scope.Close(Undefined());');
        }
        else if (funcInfo.returnType === 'buffer') {
          f('string ret = ' + funcInfo.funcInvocation + '(' + callargs.join(', ') + ');');
          f('return scope.Close(convStringToJsBuffer(ret));');
        }
        else if (funcInfo.returnType === undefined) {
          f('// No return type');
        }
        else {
          var returnType = typereg.getType(funcInfo.returnType);
          if (!returnType) {
            throw new Error('No such type ' + funcInfo.returnType + ' for ' + jsFuncname);
          }
          
          f(returnType.typename + ' ret = ' + getFunctionCallExpr(funcInfo.funcInvocation, callargs) + ';');
          f('return scope.Close(' + typereg.types[returnType.typename].getCppToJsExpr('ret') + ');');
        }
        f('} catch (exception &ex) {');
        f('return ThrowTypeError(ex.what());');
        f('}');
        f('}');
      });
      f('return ThrowInvalidArgs();');
      f('}');

      if (funcTemplateType) { // make it a factory function
        initFuncs.push('node::SetMethod(exports->Get(String::NewSymbol("' + funcTemplateType.jsTypename + '"))->ToObject(), "' + jsFuncname + '", jsWrap_' + jsScopedFuncname + ');');
      } else {
        initFuncs.push('node::SetMethod(exports, "' + jsFuncname + '", jsWrap_' + jsScopedFuncname + ');');
      }
    });
  });

  f('void jsInit_functions(Handle<Object> exports) {');
  _.each(initFuncs, function(s) {
    f(s);
  });
  
  f('}');

};

TypeRegistry.prototype.getSchemas = function() {
  var typereg = this;
  var schemas = {};
  _.each(typereg.types, function(type, typename) {
    if (type.typename !== typename) return;
    if (type.isPtr()) return;
    schemas[type.jsTypename] = type.getSchema();
  });
  return schemas;
};

TypeRegistry.prototype.emitSchema = function(files) {
  var typereg = this;
  var f = files.getFile('schema_' + typereg.groupname + '.json');
  var schemas = typereg.getSchemas();
  f(JSON.stringify(schemas));
};

TypeRegistry.prototype.getNamedType = function(typename) {
  var typereg = this;
  var type = typereg.types[typename];
  if (!type) {
    if (/</.test(typename)) {
      if (0) console.log('Creating template', typename);
      type = new CollectionCType(typereg, typename);
    }
    if (!type) throw new Error('No pattern for type ' + typename);
    typereg.types[typename] = type;
  }
  return type;
};

/* ----------------------------------------------------------------------
*/

TypeRegistry.prototype.scanCFunctions = function(text) {
  var typereg = this;
  var typenames = _.keys(typereg.types);
  var typenameExpr = typenames.join('|');
  var typeExpr = '(' + typenameExpr + ')\\s+' + '(|const\\s+&|&)';
  var argExpr = typeExpr + '\\s*(\\w+)';
  var funcnameExpr = '\\w+|operator\\s*[^\\s\\w]+';

  // try to eliminate class-scoped functions.
  // text = text.replace(/struct.*{[.\n]*\n}/, '');

  for (var arity=0; arity < 5; arity++) {

    var argsExpr = _.range(0, arity).map(function() { return argExpr; }).join('\\s*,\\s*');
    
    var funcExpr = ('(' + typenameExpr + ')\\s+' + 
                    '(' + typenameExpr + '::)?' +
                    '(' + funcnameExpr + ')\\s*' +
                    '(<\\s*(' + typenameExpr + ')\\s*>)?' +
                    '\\(' + argsExpr + '\\)\\s*;');

    var re = new RegExp(funcExpr, 'g');
    
    var m;
    while ((m = re.exec(text))) {
      var desc = m[0];
      var returnType = m[1];
      var funcScope = m[2] || '';
      var funcname = m[3].replace(/\s+/g, '');
      var funcTemplate = m[5] || '';
      var args = _.range(0, arity).map(function(i) {
        return {typename: m[6+i*3],
                passing: m[7+i*3].replace(/\s+/g, ''),
                argname: m[8+i*3]};
      });

      typereg.addWrapFunction(desc, funcScope, funcname, funcTemplate, returnType, args);

    }
  }
  if (0) console.log(typereg.wrapFunctions);
};

TypeRegistry.prototype.scanCHeader = function(fn) {
  var typereg = this;
  var rawFile = fs.readFileSync(fn, 'utf8');
  typereg.scanCFunctions(rawFile);
  typereg.extraJsWrapFuncsHeaders.push('#include "' + fn + '"');
};

TypeRegistry.prototype.emitRtFunctions = function(files) {
  var typereg = this;

  // For now put them all in one file. It might make sense to split out at some point
  var hl = files.getFile('rtfns_' + typereg.groupname + '.h');

  // Make a list of all includes: collect all types for all functions, then collect the customerIncludes for each type, and remove dups
  var allIncludes = _.uniq(_.flatten(_.map(_.flatten(_.map(typereg.rtFunctions, function(func) { return func.getAllTypes(); })), function(typename) {
    var type = typereg.types[typename];
    return type.getCustomerIncludes();
  })));
  _.each(allIncludes, function(incl) {
    hl(incl);
  });

  var cl = files.getFile('rtfns_' + typereg.groupname + '.cc');
  cl('#include "tlbcore/common/std_headers.h"');
  cl('#include "./rtfns_' + typereg.groupname + '.h"');

  _.each(typereg.rtFunctions, function(func, funcname) {
    func.emitDecl(hl);
    func.emitDefn(cl);
  });
};


TypeRegistry.prototype.addWrapFunction = function(desc, funcScope, funcname, funcTemplate, returnType, args) {
  var typereg = this;
  var jsFuncname = funcnameCToJs(funcname);
  if (!(jsFuncname in typereg.wrapFunctions)) {
    typereg.wrapFunctions[jsFuncname] = [];
  }
  typereg.wrapFunctions[jsFuncname].push({desc: desc,
                                          funcScope: funcScope,
                                          funcname: funcname,
                                          funcTemplate: funcTemplate,
                                          funcInvocation: funcScope + funcname + (funcTemplate.length ? '< ' + funcTemplate + ' >' : ''),
                                          returnType: returnType,
                                          args: args});
};

TypeRegistry.prototype.addRtFunction = function(name, inargs, outargs) {
  var typereg = this;
  return typereg.rtFunctions[name] = new gen_functions.RtFunction(typereg, name, inargs, outargs);
};

// ----------------------------------------------------------------------


function emitArgSwitch(f, typereg, thisType, argSets) {

  if (thisType) {
    f('JsWrap_' + thisType.jsTypename + '* thisObj = node::ObjectWrap::Unwrap<JsWrap_' + thisType.jsTypename + '>(args.This());');
  }

  var ifSep = '';
  _.each(argSets, function(argSet) {
    
    f(ifSep + 'if (args.Length() ' + (argSet.ignoreExtra ? '>=' : '==') + ' ' + argSet.args.length +
      _.map(argSet.args, function(argInfo, argi) {
        var argType = typereg.getType(argInfo);
	if (!argType) {
	  throw new Error('No type found for ' + util.inspect(argInfo) + ' in [' + util.inspect(argSet) + ']');
	}
        return ' && ' + argType.getJsToCppTest('args[' + argi + ']');
      }).join('') +
      ') {');
    
    _.each(argSet.args, function(argInfo, argi) {
      var argType = typereg.getType(argInfo);
      f(argType.getArgTempDecl('a' + argi) + ' = ' + argType.getJsToCppExpr('args[' + argi + ']') + ';');
    });

    if (argSet.returnType) {
      if (argSet.returnType === 'buffer') {
        f('string ret;');
        argSet.code();
        f('return scope.Close(convStringToJsBuffer(ret));');
      } else {
        var returnType = typereg.getType(argSet.returnType);
	if (returnType.isStruct || returnType.isCollection) {
          f('shared_ptr<' + returnType.typename + '> ret_ptr = make_shared<' + returnType.typename + '>();');
	  f(returnType.typename + ' &ret = *ret_ptr;');
          argSet.code();
          f('return scope.Close(' + returnType.getCppToJsExpr('ret_ptr') + ');');
	}
	else {
          f(returnType.typename + ' ret;');
          argSet.code();
          f('return scope.Close(' + returnType.getCppToJsExpr('ret') + ');');
	}
      }
    } else {
      argSet.code();
    }
    
    f('}');
    ifSep = 'else ';
  });

  f(ifSep + ' {');

  if (0) {
    f('eprintf("No matching args:\\n");');
    _.each(argSets, function(argSet) {
      f('eprintf("  argSet: ");');
      _.each(argSet.args, function(argInfo, argi) {
        var argType = typereg.getType(argInfo);
        f('eprintf("  %s' +  argType.typename + '", (' + argType.getJsToCppTest('args[' + argi + ']') + ') ? "" : "!");')
      });
      f('eprintf("\\n");');
    });
  }

  f('return ThrowInvalidArgs();');
  f('}');
}

function emitJsWrap(f, fn, contents) {
  f('Handle<Value> jsWrap_' + fn + '(Arguments const &args) {');
  f('HandleScope scope;');
  contents();
  f('}');
}

function emitJsAccessors(f, getContents, setContents) {
}


// ----------------------------------------------------------------------

function CType(reg, typename) {
  var type = this;
  assert.ok(typename);
  type.reg = reg;
  type.typename = typename;
  type.jsTypename = typename.replace(/>+$/g, '').replace(/</g, '_').replace(/>/g, '_').replace(/,/g,'_').replace(/::/g,'_');
  
  type.extraFunctionDecls = [];
  type.extraMemberDecls = [];
  type.extraConstructorArgs = [];
  type.extraHostCode = [];
  type.extraDeclDependencies = [];
  type.extraDefnDependencies = [];
  type.extraJsWrapHeaderIncludes = [];
  type.extraHeaderIncludes = [];
  type.extraConstructorCode = [];
  type.extraDestructorCode = [];
  type.arrayConversions = [];
}

CType.prototype.getConstructorArgs = function() {
  return this.extraConstructorArgs;
};

CType.prototype.nonPtrType = function() {
  return this;
};

CType.prototype.isPod = function() {
  return false;
};

CType.prototype.isPtr = function() {
  return false;
};

CType.prototype.isCopyConstructable = function() {
  return true;
};

CType.prototype.hasArrayNature = function() {
  return false;
};

CType.prototype.hasJsWrapper = function() {
  return false;
};

CType.prototype.getSchema = function() {
  return {typename: this.jsTypename, hasArrayNature: this.hasArrayNature(), members: this.getMembers()};
};

CType.prototype.getCppToJsExpr = function(valueExpr, parentExpr, ownerExpr) {
  var type = this;
  throw new Error('no ValueNew for ' + type.typename);
};


CType.prototype.getMembers = function() {
  return [];
};

CType.prototype.getFnBase = function() {
  return this.jsTypename;
};

CType.prototype.getFns = function() {
  var type = this;
  var base = type.getFnBase();
  return {
    hostCode: type.noHostCode ? undefined : base + '_host.cc',
    jsTestCode: 'test_' + base + '.js',
    typeHeader: type.noHostCode ? undefined : base + '_decl.h',
    jsWrapHeader: base + '_jsWrap.h',
    jsWrapCode: base + '_jsWrap.cc',
  };
};

CType.prototype.emitAll = function(files) {
  var type = this;
  var fns = type.getFns();
  if (0) console.log('emitAll', type.typename, fns);
  if (fns.hostCode) {
    type.emitHostCode(files.getFile(fns.hostCode).child({TYPENAME: type.typename}));
  }
  if (fns.typeHeader) {
    type.emitHeader(files.getFile(fns.typeHeader).child({TYPENAME: type.typename}));
  }
  if (fns.jsWrapHeader) {
    type.emitJsWrapHeader(files.getFile(fns.jsWrapHeader).child({TYPENAME: type.typename, JSTYPE: type.jsTypename}));
  }
  if (fns.jsWrapCode) {
    type.emitJsWrapCode(files.getFile(fns.jsWrapCode).child({TYPENAME: type.typename, JSTYPE: type.jsTypename}));
  }
};


CType.prototype.getCustomerIncludes = function() {
  var type = this;
  var base = type.getFnBase();
  return ['#include "' + base + '_decl.h"'];
};

CType.prototype.getHeaderIncludes = function() {
  var type = this;
  var ret = [];
  _.each(type.extraHeaderIncludes, function(hdr) {
    ret.push('#include "' + hdr + '"');
  });
  _.each(type.getDeclDependencies(), function(othertype) {
    var fns = othertype.getFns();
    if (fns && fns.typeHeader) {
      ret.push('#include "' + fns.typeHeader + '"');
    }
  });
  return ret;
};

CType.prototype.getSignature = function() {
  var type = this;
  var syn = type.getSynopsis();
  var h = crypto.createHash('sha1');
  h.update(syn);
  return h.digest('base64').substr(0, 8);
};

CType.prototype.getTypeAndVersion = function() {
  var type = this;
  return type.typename + '@' + type.getSignature();
};

CType.prototype.declMember = function(it) {
  var type = this;
  type.extraMemberDecls.push(it);
};

CType.prototype.declFunctions = function(it) {
  var type = this;
  type.extraFunctionDecls.push(it);
};

CType.prototype.getDefnDependencies = function() {
  var type = this;
  return sortTypes(type.extraDefnDependencies);
};

CType.prototype.getAllTypes = function() {
  var type = this;
  var subtypes = sortTypes(nonPtrTypes(_.flatten(_.map(type.getMemberTypes(), function(t) { return [t].concat(t.getAllTypes()); }))));
  if (0) console.log('CType.getAllTypes', type.typename, _.map(subtypes, function(type) { return type.typename; }));
  
  return subtypes;
};

CType.prototype.getDeclDependencies = function() {
  var type = this;
  var subtypes = sortTypes(type.getAllTypes().concat(type.extraDeclDependencies));
  if (0) console.log('CType.getDeclDependencies', type.typename, _.map(subtypes, function(type) { return type.typename; }));
  return subtypes;
};

CType.prototype.addDeclDependency = function(t) {
  var type = this;
  assert.ok(t);
  type.extraDeclDependencies.push(t);
};

CType.prototype.getMemberTypes = function() {
  return [];
};
  

// ----------------------------------------------------------------------

CType.prototype.emitHeader = function(f) {
  var type = this;
  f('#include "tlbcore/common/jsonio.h"');
  _.each(type.getHeaderIncludes(), function(l) {
    f(l);
  });
  type.emitForwardDecl(f);
  type.emitTypeDecl(f);
  type.emitFunctionDecl(f);
};

CType.prototype.emitHostCode = function(f) {
  var type = this;
  f('#include "tlbcore/common/std_headers.h"');
  var fns = type.getFns();
  if (fns.typeHeader) {
    f('#include "' + fns.typeHeader + '"');
  }
  f('');
  type.emitHostImpl(f);
  _.each(type.extraHostCode, function(l) {
    f(l);
  });
};

CType.prototype.emitJsWrapHeader = function(f) {
  var type = this;
  _.each(type.getDeclDependencies().concat([type]), function(othertype) {
    var fns = othertype.getFns();
    if (fns && fns.typeHeader) {
      f('#include "' + fns.typeHeader + '"');
    }
  });
  _.each(type.extraJsWrapHeaderIncludes, function(include) {
    f('#include "' + include + '"');
  });

  type.emitJsWrapDecl(f);
};

CType.prototype.emitJsWrapCode = function(f) {
  var type = this;
  f('#include "tlbcore/common/std_headers.h"');
  f('#include "tlbcore/nodeif/jswrapbase.h"');
  var fns = type.getFns();
  if (fns.typeHeader) {
    f('#include "' + fns.typeHeader + '"');
  }
  if (fns.jsWrapHeader) {
    f('#include "' + fns.jsWrapHeader + '"');
  }
  f('/* declDependencies = ' + _.map(type.getDeclDependencies(), function(ot) { return ot.jsTypename; }) + ' */');
  _.each(type.getDeclDependencies(), function(othertype) {
    var fns = othertype.getFns();
    if (fns && fns.jsWrapHeader) {
      f('#include "' + fns.jsWrapHeader + '"');
    }
  });
  f('#include "' + type.getFns().jsWrapHeader + '"');
  type.emitJsWrapImpl(f);
};

CType.prototype.emitJsTestImpl = function(f) {
};

// ----------------------------------------------------------------------


CType.prototype.emitForwardDecl = function(f) {
};

CType.prototype.emitTypeDecl = function(f) {
};

CType.prototype.emitFunctionDecl = function(f) {
  var type = this;
  _.each(type.extraFunctionDecls, function(l) {
    f(l);
  });
};

CType.prototype.emitHostImpl = function(f) {
};

CType.prototype.emitJsWrapDecl = function(f) {
};

CType.prototype.emitJsWrapImpl = function(f) {
};

CType.prototype.emitVarDecl = function(f, varname) {
  var type = this;
  f(type.typename + ' ' + varname + ';');
};

CType.prototype.getFormalParameter = function(varname) {
  var type = this;
  return type.typename + ' ' + varname;
};

CType.prototype.getInitExpr = function() {
  return this.getAllZeroExpr();
}


// ----------------------------------------------------------------------

function PrimitiveCType(reg, typename) {
  CType.call(this, reg, typename);
}
PrimitiveCType.prototype = Object.create(CType.prototype);

PrimitiveCType.prototype.isPrimitive = true;

PrimitiveCType.prototype.getFns = function() {
  return {};
};

PrimitiveCType.prototype.emitJsWrapDecl = function(f) {
  f('char const * getTypeVersionString(TYPENAME const &);');
  f('char const * getTypeName(TYPENAME const &);');
  f('char const * getJsTypeName(TYPENAME const &);');
  f('char const * getSchema(TYPENAME const &);');
};


PrimitiveCType.prototype.getSynopsis = function() {
  return '(' + this.typename + ')';
};

PrimitiveCType.prototype.getAllOneExpr = function() {
  switch (this.typename) {
  case 'float': return '1.0f';
  case 'double': return '1.0';
  case 'int': return '1';
  case 'u_int': return '1u';
  case 'bool': return 'true';
  case 'string': return 'string("1")';
  case 'jsonstr': return 'jsonstr("1")';
  default: return '***ALL_ONE***';
  }
};

PrimitiveCType.prototype.getAllZeroExpr = function() {
  switch (this.typename) {
  case 'float': return '0.0f';
  case 'double': return '0.0';
  case 'int': return '0';
  case 'u_int': return '0';
  case 'bool': return 'false';
  case 'string': return 'string()';
  case 'jsonstr': return 'jsonstr()';
  default: return '***ALL_ZERO***';
  }
};

PrimitiveCType.prototype.getAllNanExpr = function() {
  switch (this.typename) {
  case 'float': return 'numeric_limits<float>::quiet_NaN()';
  case 'double': return 'numeric_limits<double>::quiet_NaN()';
  case 'int': return '0x80000000';
  case 'u_int': return '0x80000000';
  case 'bool': return 'false';
  case 'string': return 'string(\"nan\")';
  case 'jsonstr': return 'jsonstr(\"undefined\")';
  default: return '***ALL_NAN***';
  }
};

PrimitiveCType.prototype.getExampleValueJs = function() {
  switch (this.typename) {
  case 'int':
    return '7';
  case 'u_int':
    return '8';
  case 'float':
    return '5.5';
  case 'double':
    return '9.5';
  case 'bool':
    return 'true';
  case 'string':
    return '"foo"';
  case 'jsonstr':
    return '"{\\"foo\\":1}"';
  default:
    throw new Error('PrimitiveCType.getExampleValue unimplemented for type ' + this.typename);
  }
};

PrimitiveCType.prototype.isPod = function() {
  var type = this;
  switch (type.typename) {
  case 'string':
  case 'jsonstr':
    return false;
  default:
    return true;
  }
};

PrimitiveCType.prototype.getFormalParameter = function(varname) {
  var type = this;
  switch (type.typename) {
  case 'string':
  case 'jsonstr':
    return type.typename + ' const &' + varname;
  default:
    return type.typename + ' ' + varname;
  }
};

PrimitiveCType.prototype.getArgTempDecl = function(varname) {
  var type = this;
  switch (type.typename) {
  case 'X_string':
  case 'X_jsonstr':
    return type.typename + ' const &' + varname;
  default:
    return type.typename + ' ' + varname;
  }
};

PrimitiveCType.prototype.getVarDecl = function(varname) {
  var type = this;
  return type.typename + ' ' + varname;
};

PrimitiveCType.prototype.getJsToCppTest = function(valueExpr) {
  var type = this;
  switch (type.typename) {
  case 'int':
  case 'u_int':
  case 'float':
  case 'double':
    return '((' + valueExpr + ')->IsNumber())';
  case 'bool':
    return '((' + valueExpr + ')->IsBoolean())';
  case 'string':
    return 'canConvJsToString(' + valueExpr + ')';
  case 'arma::cx_double':
    return 'canConvJsToCxDouble(' + valueExpr + ')';
  case 'jsonstr':
    return 'true';
  default:
    return '(JsWrap_' + type.jsTypename + '::Extract(' + valueExpr + ') != nullptr)';
    //throw new Error('Unknown primitive type');
  }
};

PrimitiveCType.prototype.getJsToCppExpr = function(valueExpr) {
  var type = this;
  switch (type.typename) {
  case 'int':
  case 'u_int':
  case 'float':
  case 'double':
    return '((' + valueExpr + ')->NumberValue())';
  case 'bool':
    return '((' + valueExpr + ')->BooleanValue())';
  case 'string':
    return 'convJsToString(' + valueExpr + ')';
  case 'jsonstr':
    return 'convJsToJsonstr(' + valueExpr + ')';
  case 'arma::cx_double':
    return 'convJsToCxDouble(' + valueExpr + ')';
  default:
    return 'JsWrap_' + type.jsTypename + '::Extract(' + valueExpr + ')';
    //throw new Error('Unknown primitive type');
  }
};

PrimitiveCType.prototype.getCppToJsExpr = function(valueExpr, parentExpr, ownerExpr) {
  var type = this;
  switch (type.typename) {
  case 'int': 
  case 'u_int': 
  case 'float': 
  case 'double':
    return 'Number::New(' + valueExpr + ')';
  case 'bool':
    return 'Boolean::New(' + valueExpr + ')';
  case 'string':
    return 'convStringToJs(' + valueExpr + ')';
  case 'jsonstr':
    return 'convJsonstrToJs(' + valueExpr + ')';
  case 'arma::cx_double':
    return 'convCxDoubleToJs(' + valueExpr + ')';
  case 'void':
    return 'Undefined()';
  default:
    throw new Error('Unknown primitive type');
  }
};

// ----------------------------------------------------------------------

function ObjectCType(reg, typename) {
  CType.call(this, reg, typename);
}
ObjectCType.prototype = Object.create(CType.prototype);

ObjectCType.prototype.isObject = true;

ObjectCType.prototype.getFns = function() {
  return {};
};

ObjectCType.prototype.getSynopsis = function() {
  return '(' + this.typename + ')';
};

ObjectCType.prototype.getAllOneExpr = function() {
  return 'nullptr';
};

ObjectCType.prototype.getAllZeroExpr = function() {
  return 'nullptr';
};

ObjectCType.prototype.getAllNanExpr = function() {
  return 'nullptr';
};

ObjectCType.prototype.getExampleValueJs = function() {
  return 'null';
};

ObjectCType.prototype.isPod = function() {
  return false;
};

ObjectCType.prototype.getFormalParameter = function(varname) {
  var type = this;
  return 'shared_ptr<' + type.baseType.typename + '> ' + varname;
};

ObjectCType.prototype.getArgTempDecl = function(varname) {
  var type = this;
  return 'shared_ptr<' + type.baseType.typename + '> ' + varname;
};

ObjectCType.prototype.getVarDecl = function(varname) {
  var type = this;
  return 'shared_ptr<' + type.baseType.typename + '> ' + varname;
};

ObjectCType.prototype.getJsToCppTest = function(valueExpr) {
  var type = this;
  return '(JsWrap_' + type.jsTypename + '::Extract(' + valueExpr + ') != nullptr)';
};

ObjectCType.prototype.getJsToCppExpr = function(valueExpr) {
  var type = this;
  return 'JsWrap_' + type.jsTypename + '::Extract(' + valueExpr + ')';
};

ObjectCType.prototype.getCppToJsExpr = function(valueExpr, parentExpr, ownerExpr) {
  var type = this;
  if (parentExpr) {
    return 'JsWrap_' + type.jsTypename + '::MemberInstance(' + parentExpr + ', &(' + valueExpr + '))';
  }
  else if (ownerExpr) {
    return 'JsWrap_' + type.jsTypename + '::DependentInstance(' + ownerExpr + ', &(' + valueExpr + '))';
  } 
  else {
    return 'JsWrap_' + type.jsTypename + '::NewInstance(' + valueExpr + ')';
  }
};


/* ----------------------------------------------------------------------
   Template types
   WRITEME: support vector<TYPENAME> and such things
*/

function CollectionCType(reg, typename) {
  var type = this;
  CType.call(type, reg, typename);

  type.templateName = '';
  type.templateArgs = [];
  type.constructorJswrapCases = [];
  type.extraJswrapMethods = [];
  type.extraJswrapAccessors = [];
  
  var depth = 0;
  var argi = 0;
  _.each(typename, function(c) {
    if (c === '<') {
      depth ++;
    }
    else if (c === '>') {
      depth --;
      argi++;
    }
    else if (c === ',') {
      argi++;
    }
    else {
      if (depth === 0) {
        type.templateName = type.templateName + c;
      }
      else {
        if (!type.templateArgs[argi]) type.templateArgs[argi] = '';
        type.templateArgs[argi] = type.templateArgs[argi] + c;
      }
    }
  });

  type.templateArgTypes = _.map(type.templateArgs, function(name) { return type.reg.types[name]; });
  if (0) console.log('template', typename, type.templateName, type.templateArgs);
}
CollectionCType.prototype = Object.create(CType.prototype);
CollectionCType.prototype.isCollection = true;

CollectionCType.prototype.hasJsWrapper = function() {
  return true;
};

CollectionCType.prototype.getSynopsis = function() {
  return '(' + this.typename + ')';
};

CollectionCType.prototype.getInitExpr = function() {
  var type = this;
  if (/arma::.*::fixed/.test(type.templateName)) {
    return 'arma::fill::zeros';
  } else {
    return '';
  }
}

CollectionCType.prototype.getAllOneExpr = function() {
  return this.typename + '()';
};

CollectionCType.prototype.getAllZeroExpr = function() {
  return this.typename + '()';
};

CollectionCType.prototype.getAllNanExpr = function() {
  return this.typename + '()';
};

CollectionCType.prototype.getExampleValueJs = function() {
  return 'new ur.' + this.jsTypename + '()';
};

CollectionCType.prototype.isPod = function() {
  return false;
};

CollectionCType.prototype.getFormalParameter = function(varname) {
  var type = this;
  return type.typename + ' const &' + varname;
};

CollectionCType.prototype.getArgTempDecl = function(varname) {
  var type = this;
  return type.typename + ' &' + varname;
};

CollectionCType.prototype.getVarDecl = function(varname) {
  var type = this;
  return type.typename + ' ' + varname;
};

CollectionCType.prototype.getJsToCppTest = function(valueExpr) {
  var type = this;
  return '(JsWrap_' + type.jsTypename + '::Extract(' + valueExpr + ') != nullptr)';
};

CollectionCType.prototype.getJsToCppExpr = function(valueExpr) {
  var type = this;
  return '(*JsWrap_' + type.jsTypename + '::Extract(' + valueExpr + '))';
};

CollectionCType.prototype.getCppToJsExpr = function(valueExpr, parentExpr, ownerExpr) {
  var type = this;
  
  if (parentExpr) {
    return 'JsWrap_' + type.jsTypename + '::MemberInstance(' + parentExpr + ', &(' + valueExpr + '))';
  } 
  else if (ownerExpr) {
    return 'JsWrap_' + type.jsTypename + '::DependentInstance(' + ownerExpr + ', ' + valueExpr + ')';
  } 
  else {
    return 'JsWrap_' + type.jsTypename + '::NewInstance(' + valueExpr + ')';
  }
};


CollectionCType.prototype.getMemberTypes = function() {
  var type = this;
  var subtypes = sortTypes(_.filter(_.map(type.typename.split(/\s*[<,>]\s*/), function(typename1) {
    return typename1.length > 0 ? type.reg.types[typename1] : null;
  }), function(type) { return type; }));
  if (0) console.log('CollectionCType.getMemberTypes', type.typename, _.map(subtypes, function(type) { return type.typename; }));
  return subtypes;
};

CollectionCType.prototype.emitJsWrapDecl = function(f) {
  var type = this;
  if (0 && type.isRef) {
    f('typedef JsWrapGenericRef< TYPENAME > JsWrap_JSTYPE;');
  } else {
    f('typedef JsWrapGeneric< TYPENAME > JsWrap_JSTYPE;');
  }
  f('Handle<Value> jsConstructor_JSTYPE(JsWrap_JSTYPE *it, const Arguments &args);');
  f('Handle<Value> jsToJSON_JSTYPE(TYPENAME const &it);');
};

CollectionCType.prototype.emitJsWrapImpl = function(f) {
  var type = this;
  var methods = [];
  var factories = [];
  var accessors = [];
  var accessorsRo = [];

  f('/*\ntemplateName = "' + type.templateName + '"' + '\n' +
    'templateArgs = "' + util.inspect(type.templateArgs) + '"\n' +
    '*/');

  if (1) {
    f('static Handle<Value> jsNew_JSTYPE(const Arguments& args) {');
    f('HandleScope scope;');
    f('if (!(args.This()->InternalFieldCount() > 0)) return ThrowInvalidThis();');
    f('JsWrap_JSTYPE* thisObj = new JsWrap_JSTYPE();');
    f('return jsConstructor_JSTYPE(thisObj, args);');
    f('}');
    f('');
  }

  if (1) {
    f('Handle<Value> jsConstructor_JSTYPE(JsWrap_JSTYPE *it, const Arguments& args) {');
    f('HandleScope scope;');
    
    f('if (0) {');
    f('}');
    // When creating a vector<double>, allow passing in various native JS arrays
    if (type.templateName === 'vector') {
      f('else if (args.Length() == 1 && args[0]->IsNumber()) {');
      f('size_t a0 = args[0]->NumberValue();');
      f('it->assignConstruct(a0);');
      f('}');
      f('else if (args.Length() == 0) {');
      f('it->assignDefault();');
      f('}');
    }

    else if (type.templateName === 'arma::Col' || type.templateName === 'arma::Row' || type.templateName === 'arma::Col::fixed' || type.templateName === 'arma::Row::fixed') {
      f('else if (args.Length() == 0) {');
      if (/.*::fixed$/.test(type.templateName)) {
        f('it->assignConstruct(arma::fill::zeros);');
      } else {
        f('it->assignDefault();');
      }
      f('}');
      if (!/.*::fixed$/.test(type.templateName)) {
        f('else if (args.Length() == 1 && args[0]->IsNumber()) {');
        f('it->assignConstruct((size_t)args[0]->NumberValue(), arma::fill::zeros);');
        f('}');
      }
      f('else if (args.Length() == 1 && canConvJsToArmaVec<' + type.templateArgs[0] + '>(args[0])) {');
      f('it->assignConstruct(convJsToArmaVec<' + type.templateArgs[0] + '>(args[0]));');
      f('}');
    }

    else if (type.templateName === 'arma::Mat' || type.templateName === 'arma::Mat::fixed') {
      f('else if (args.Length() == 0) {');
      if (/.*::fixed$/.test(type.templateName)) {
        f('it->assignConstruct(arma::fill::zeros);');
      } else {
        f('it->assignDefault();');
      }
      f('}');
      if (!/.*::fixed$/.test(type.templateName)) {
        f('else if (args.Length() == 2 && args[0]->IsNumber() && args[1]->IsNumber()) {');
        f('it->assignConstruct((size_t)args[0]->NumberValue(), (size_t)args[1]->NumberValue(), arma::fill::zeros);');
        f('}');
      }
      f('else if (args.Length() == 1 && canConvJsToArmaMat<' + type.templateArgs[0] + '>(args[0])) {');
      f('it->assignConstruct(convJsToArmaMat<' + type.templateArgs[0] + '>(args[0]));');
      f('}');
    }

    // When creating a map<string, jsonstr>, allow passing in an object
    else if (type.templateName === 'map' && type.templateArgs[0] === 'string' && type.templateArgs[1] === 'jsonstr') {
      f('else if (args.Length() == 0) {');
      f('it->assignDefault();');
      f('}');
      f('else if (args.Length() == 1 && canConvJsToMapStringJsonstr(args[0])) {');
      f('it->assignConstruct(convJsToMapStringJsonstr(args[0]));');
      f('}');
    }
    else if (type.templateName === 'arma::subview_row') {
      f('else if (args.Length() == 0) {');
      f('}');
    }
    else if (type.templateName === 'arma::subview_col') {
      f('else if (args.Length() == 0) {');
      f('}');
    }
    _.each(type.constructorJswrapCases, function(it) {
      it.call(type, f);
    });

    f('else {');
    if (0) f('eprintf("JSTYPE: Invalid args, len=%d\\n", (int)args.Length());');
    f('return ThrowInvalidArgs();');
    f('}');

    f('it->Wrap2(args.This());');
    f('return args.This();');
    f('}');
  }

  if (!type.noSerialize) {
    f('Handle<Value> jsToJSON_JSTYPE(const TYPENAME &it) {');
    f('if (fastJsonFlag) {');
    f('string fjbItem = asJson(it).it;');
    f('if (fjbItem.size() > 20) {');
    f('Local<Object> ret = Object::New();');
    f('ret->Set(String::NewSymbol("__wsType"), String::New("jsonString"));');
    f('ret->Set(String::NewSymbol("json"), convStringToJs(fjbItem));');
    f('return ret;');
    f('}');
    f('}');

    if (type.templateName === 'vector') {
      f('Local<Array> ret = Array::New(it.size());');
      f('for (size_t i=0; i<it.size(); i++) {');
      f('ret->Set(i, ' + type.templateArgTypes[0].getCppToJsExpr('it[i]') + ');');
      f('}');
      f('return ret;');
    }
    else if (type.templateName === 'arma::Col' || type.templateName === 'arma::Row' || type.templateName === 'arma::Col::fixed' || type.templateName === 'arma::Row::fixed') {
      f('Local<Array> ret = Array::New(it.n_elem);');
      f('for (size_t i=0; i<it.n_elem; i++) {');
      f('ret->Set(i, ' + type.templateArgTypes[0].getCppToJsExpr('it[i]') + ');');
      f('}');
      f('return ret;');
    }
    else if (type.templateName === 'arma::Mat' || type.templateName === 'arma::Mat::fixed') {
      f('Local<Array> ret = Array::New(it.n_elem);');
      f('for (size_t i=0; i<it.n_elem; i++) {');
      f('ret->Set(i, ' + type.templateArgTypes[0].getCppToJsExpr('it[i]') + ');');
      f('}');
      f('return ret;');
    }
    else if (type.templateName === 'map' && type.templateArgs[0] === 'string') {
      f('Local<Object> ret = Object::New();');
      f('for (TYPENAME::const_iterator i=it.begin(); i!=it.end(); i++) {');
      f('ret->Set(' + type.templateArgTypes[0].getCppToJsExpr('i->first') + ', ' + type.templateArgTypes[1].getCppToJsExpr('i->second') + ');');
      f('}');
      f('return ret;');
    }
    else {
      f('return Undefined();');
    }
    f('}');

    emitJsWrap(f, 'JSTYPE_toJSON', function() {
      emitArgSwitch(f, type.reg, type, [{
        args: [], ignoreExtra: true, code: function() {
          f('return scope.Close(jsToJSON_JSTYPE(*thisObj->it));');
        }
      }]);
    });
    methods.push('toJSON');
  }

  if (type.templateName === 'map' && type.templateArgs[0] === 'string') {
    var valueType = type.reg.types[type.templateArgs[1]];
    f('static Handle<Value> jsGetNamed_JSTYPE(Local<String> name, AccessorInfo const &ai) {');
    f('HandleScope scope;');
    f('JsWrap_JSTYPE* thisObj = node::ObjectWrap::Unwrap<JsWrap_JSTYPE>(ai.This());');
    f('string key = convJsToString(name);');
    f('TYPENAME::iterator iter = thisObj->it->find(key);');
    // return an empty handle if not found, will be looked up on prototype chain
    // It doesn't work if you return scope.Close(Undefined());
    f('if (iter == thisObj->it->end()) return scope.Close(Handle<Value>());');
    f('return scope.Close(' + type.reg.types[type.templateArgs[1]].getCppToJsExpr('iter->second', 'thisObj->it') + ');');
    f('}');

    f('static Handle<Value> jsSetNamed_JSTYPE(Local<String> name, Local<Value> value, AccessorInfo const &ai) {');
    f('HandleScope scope;');
    f('JsWrap_JSTYPE* thisObj = node::ObjectWrap::Unwrap<JsWrap_JSTYPE>(ai.This());');
    f('string key = convJsToString(name);');
    f('if (' + valueType.getJsToCppTest('value') + ') {');
    f(type.templateArgs[1] + ' cvalue(' + valueType.getJsToCppExpr('value') + ');');
    f('(*thisObj->it)[key] = cvalue;');
    f('return scope.Close(value);');
    f('}');
    f('else {');
    f('return scope.Close(ThrowTypeError("Expected ' + valueType.typename + '"));');
    f('}');
    f('}');
    accessors.push({isNamed: true, get: true, set: true});
  }

  if (type.templateName === 'arma::Col' || 
      type.templateName === 'arma::subview_row' || 
      type.templateName === 'arma::subview_col') {
    var elType = type.reg.types[type.templateArgs[0]];
    f('static Handle<Value> jsGet_JSTYPE_n_rows(Local<String> name, AccessorInfo const &ai) {');
    f('HandleScope scope;');
    f('JsWrap_JSTYPE* thisObj = node::ObjectWrap::Unwrap<JsWrap_JSTYPE>(ai.This());');
    f('return scope.Close(Number::New(thisObj->it->n_rows));');
    f('}');
    accessors.push({name: 'n_rows', get: true});
    f('static Handle<Value> jsGet_JSTYPE_n_elem(Local<String> name, AccessorInfo const &ai) {');
    f('HandleScope scope;');
    f('JsWrap_JSTYPE* thisObj = node::ObjectWrap::Unwrap<JsWrap_JSTYPE>(ai.This());');
    f('return scope.Close(Number::New(thisObj->it->n_elem));');
    f('}');
    accessors.push({name: 'n_elem', get: true});

    f('static Handle<Value> jsGetIndexed_JSTYPE(unsigned int index, AccessorInfo const &ai) {');
    f('HandleScope scope;');
    f('JsWrap_JSTYPE* thisObj = node::ObjectWrap::Unwrap<JsWrap_JSTYPE>(ai.This());');
    f('if (index >= thisObj->it->n_elem) return scope.Close(Undefined());');
    f('return scope.Close(' + elType.getCppToJsExpr('(*thisObj->it)(index)', 'thisObj->it') + ');');
    f('}');

    f('static Handle<Value> jsSetIndexed_JSTYPE(unsigned int index, Local<Value> value, AccessorInfo const &ai) {');
    f('HandleScope scope;');
    f('JsWrap_JSTYPE* thisObj = node::ObjectWrap::Unwrap<JsWrap_JSTYPE>(ai.This());');
    f('if (index >= thisObj->it->n_elem) return ThrowRuntimeError(stringprintf("Index %d >= size %d", (int)index, (int)thisObj->it->n_elem).c_str());');
    f('if (' + elType.getJsToCppTest('value') + ') {');
    f(type.templateArgs[0] + ' cvalue(' + elType.getJsToCppExpr('value') + ');');
    f('(*thisObj->it)(index) = cvalue;');
    f('return scope.Close(value);');
    f('}');
    f('else {');
    f('return scope.Close(ThrowTypeError("Expected ' + elType.typename + '"));');
    f('}');
    f('}');
    accessors.push({isIndexed: true, get: true, set: true});
  }

  if (type.templateName === 'arma::Mat') {
    f('static Handle<Value> jsGet_JSTYPE_n_rows(Local<String> name, AccessorInfo const &ai) {');
    f('HandleScope scope;');
    f('JsWrap_JSTYPE* thisObj = node::ObjectWrap::Unwrap<JsWrap_JSTYPE>(ai.This());');
    f('return scope.Close(Number::New(thisObj->it->n_rows));');
    f('}');
    accessors.push({name: 'n_rows', get: true});
    f('static Handle<Value> jsGet_JSTYPE_n_cols(Local<String> name, AccessorInfo const &ai) {');
    f('HandleScope scope;');
    f('JsWrap_JSTYPE* thisObj = node::ObjectWrap::Unwrap<JsWrap_JSTYPE>(ai.This());');
    f('return scope.Close(Number::New(thisObj->it->n_cols));');
    f('}');
    accessors.push({name: 'n_cols', get: true});
    f('static Handle<Value> jsGet_JSTYPE_n_elem(Local<String> name, AccessorInfo const &ai) {');
    f('HandleScope scope;');
    f('JsWrap_JSTYPE* thisObj = node::ObjectWrap::Unwrap<JsWrap_JSTYPE>(ai.This());');
    f('return scope.Close(Number::New(thisObj->it->n_elem));');
    f('}');
    accessors.push({name: 'n_elem', get: true});

    emitJsWrap(f, 'JSTYPE_row', function() {
      emitArgSwitch(f, type.reg, type, [{
        args: ['u_int'], code: function() {
          f('return scope.Close(' + type.reg.getType('arma::subview_row<' + type.templateArgs[0] + '>').getCppToJsExpr('thisObj->it->row(a0)', null, 'args.This()') + ');');
        }
      }]);
    });
    methods.push('row');

    emitJsWrap(f, 'JSTYPE_col', function() {
      emitArgSwitch(f, type.reg, type, [{
        args: ['u_int'], code: function() {
          f('return scope.Close(' + type.reg.getType('arma::subview_col<' + type.templateArgs[0] + '>').getCppToJsExpr('thisObj->it->col(a0)', null, 'args.This()') + ');');
        }
      }]);
    });
    methods.push('col');

    f('static Handle<Value> jsGetIndexed_JSTYPE(unsigned int index, AccessorInfo const &ai) {');
    f('HandleScope scope;');
    f('JsWrap_JSTYPE* thisObj = node::ObjectWrap::Unwrap<JsWrap_JSTYPE>(ai.This());');
    f('if (index >= thisObj->it->n_rows) return scope.Close(Undefined());');
    f('return scope.Close(' + type.reg.getType('arma::subview_row<' + type.templateArgs[0] + '>').getCppToJsExpr('thisObj->it->row(index)', null, 'ai.This()') + ');');
    f('}');

    if (0) { // WRITEME
      f('static Handle<Value> jsSetIndexed_JSTYPE(unsigned int index, Local<Value> value, AccessorInfo const &ai) {');
      f('HandleScope scope;');
      f('JsWrap_JSTYPE* thisObj = node::ObjectWrap::Unwrap<JsWrap_JSTYPE>(ai.This());');
      f('if (index >= thisObj->it->n_elem) return ThrowRuntimeError(stringprintf("Index %d >= size %d", (int)index, (int)thisObj->it->n_elem).c_str());');
      f(type.templateArgs[0] + ' cvalue(' + type.reg.types[type.templateArgs[0]].getJsToCppExpr('value') + ');');
      f('(*thisObj->it)(index) = cvalue;');
      f('return scope.Close(value);');
      f('}');
    }
    accessors.push({isIndexed: true, get: true, set: false});

  }


  if (type.templateName === 'vector') {

    f('static Handle<Value> jsGetIndexed_JSTYPE(unsigned int index, AccessorInfo const &ai) {');
    f('HandleScope scope;');
    f('JsWrap_JSTYPE* thisObj = node::ObjectWrap::Unwrap<JsWrap_JSTYPE>(ai.This());');
    f('if (index > thisObj->it->size()) scope.Close(Undefined());');
    f('return scope.Close(' + type.reg.types[type.templateArgs[0]].getCppToJsExpr('(*thisObj->it)[index]', 'thisObj->it') + ');');
    f('}');

    f('static Handle<Value> jsSetIndexed_JSTYPE(unsigned int index, Local<Value> value, AccessorInfo const &ai) {');
    f('HandleScope scope;');
    f('JsWrap_JSTYPE* thisObj = node::ObjectWrap::Unwrap<JsWrap_JSTYPE>(ai.This());');
    var elType = type.reg.types[type.templateArgs[0]];
    f('if (' + elType.getJsToCppTest('value') + ') {');
    f(type.templateArgs[0] + ' cvalue(' + elType.getJsToCppExpr('value') + ');');
    f('(*thisObj->it)[index] = cvalue;');
    f('return scope.Close(value);');
    f('}');
    f('else {');
    f('return scope.Close(ThrowTypeError("Expected ' + elType.typename + '"));');
    f('}');
    f('}');
    accessors.push({isIndexed: true, get: true, set: true});

    emitJsWrap(f, 'JSTYPE_pushBack', function() {
      emitArgSwitch(f, type.reg, type, [{
        args: [type.templateArgTypes[0]], code: function() {
          f('thisObj->it->push_back(a0);');
          f('return scope.Close(Undefined());');
        }
      }]);
    });
    methods.push('pushBack');

    emitJsWrap(f, 'JSTYPE_clear', function() {
      emitArgSwitch(f, type.reg, type, [{
        args: [], code: function() {
          f('thisObj->it->clear();');
          f('return scope.Close(Undefined());');
        }
      }]);
    });
    methods.push('clear');
  }

  _.each(type.extraJswrapMethods, function(it) {
    it.call(type, f, methods);
  });
  _.each(type.extraJswrapAccessors, function(it) {
    it.call(type, f, accessors);
  });

  if (!type.noSerialize) {
    emitJsWrap(f, 'JSTYPE_toJsonString', function() {
      emitArgSwitch(f, type.reg, type, [{
        args: [], returnType: 'string', code: function() {
          f('ret = asJson(*thisObj->it).it;');
        }
      }]);
    });
    methods.push('toJsonString');

    emitJsWrap(f, 'JSTYPE_inspect', function() {
      // It's given an argument, recurseTimes, which we should decrement when recursing but we don't.
      emitArgSwitch(f, type.reg, type, [{
        args: ['double'], returnType: 'string', code: function() {
          f('if (a0 >= 0) ret = asJson(*thisObj->it).it;');
        }
      }]);
    });
    methods.push('inspect');

    if (type.isCopyConstructable()) {
      emitJsWrap(f, 'JSTYPE_fromString', function() {
	emitArgSwitch(f, type.reg, null, [
          {args: ['string'], returnType: type, code: function() {
            f('const char *a0s = a0.c_str();');
            f('bool ok = rdJson(a0s, ret);');
            f('if (!ok) return ThrowInvalidArgs();');
          }}
	]);
      });
      factories.push('fromString');
      }
      
    if (!type.noPacket) {
      emitJsWrap(f, 'JSTYPE_toPacket', function() {
        emitArgSwitch(f, type.reg, type, [
          {args: [], code: function() {
            f('packet wr;');
            f('wr.add_checked(*thisObj->it);');
            f('node::Buffer *buf = node::Buffer::New((const char *)wr.rd_ptr(), wr.size());');
            f('return scope.Close(Handle<Object>(buf->handle_));'); // XXX Should I delete buf?
          }}
        ]);
      });
      methods.push('toPacket');

      if (type.isCopyConstructable()) {
	emitJsWrap(f, 'JSTYPE_fromPacket', function() {
          emitArgSwitch(f, type.reg, null, [{
            args: ['string'], returnType: type, code: function() {
              f('packet rd(a0);');
              f('try {');
              f('rd.get_checked(ret);');
              f('} catch(exception &ex) {');
              f('return ThrowRuntimeError(ex.what());');
              f('};');
            }}]);
	});
	factories.push('fromPacket');
      }
    }
  }


  if (1) { // Setup template and prototype
    f('void jsInit_JSTYPE(Handle<Object> exports) {');
    f('Local<FunctionTemplate> tpl = FunctionTemplate::New(jsNew_JSTYPE);');
    f('tpl->SetClassName(String::NewSymbol("JSTYPE"));');
    f('tpl->InstanceTemplate()->SetInternalFieldCount(1);');

    _.each(methods, function(name) {
      f('tpl->PrototypeTemplate()->Set(String::NewSymbol("' + name + '"), FunctionTemplate::New(jsWrap_JSTYPE_' + name + ')->GetFunction());');
    });
    if (!type.noSerialize) {
      f('tpl->PrototypeTemplate()->Set(String::NewSymbol("toString"), FunctionTemplate::New(jsWrap_JSTYPE_toJsonString)->GetFunction());');
    }

    f('');

    _.each(accessors, function(aInfo) {
      if (aInfo.isNamed) {
        if (aInfo.get && aInfo.set) {
          f('tpl->InstanceTemplate()->SetNamedPropertyHandler(jsGetNamed_JSTYPE, jsSetNamed_JSTYPE);');
        }
        else if (aInfo.get) {
          f('tpl->InstanceTemplate()->SetNamedPropertyHandler(jsGetNamed_JSTYPE);');
        }
      }
      else if (aInfo.isIndexed) {
        if (aInfo.get && aInfo.set) {
          f('tpl->InstanceTemplate()->SetIndexedPropertyHandler(jsGetIndexed_JSTYPE, jsSetIndexed_JSTYPE);');
        }
        else if (aInfo.get) {
          f('tpl->InstanceTemplate()->SetIndexedPropertyHandler(jsGetIndexed_JSTYPE);');
        }
      }
      else {
        if (aInfo.get && aInfo.set) {
          f('tpl->PrototypeTemplate()->SetAccessor(String::NewSymbol("' + aInfo.name + '"), ' +
            '&jsGet_JSTYPE_' + aInfo.name + ', ' +
            '&jsSet_JSTYPE_' + aInfo.name + ');');
        }
        else if (aInfo.get) {
          f('tpl->PrototypeTemplate()->SetAccessor(String::NewSymbol("' + aInfo.name + '"), ' +
            '&jsGet_JSTYPE_' + aInfo.name + ');');
        }
      }
    });
    
    f('JsWrap_JSTYPE::constructor = Persistent<Function>::New(tpl->GetFunction());');
    f('exports->Set(String::NewSymbol("JSTYPE"), JsWrap_JSTYPE::constructor);');
    _.each(factories, function(name) {
      f('JsWrap_JSTYPE::constructor->Set(String::NewSymbol("' + name + '"), FunctionTemplate::New(jsWrap_JSTYPE_' + name + ')->GetFunction());');
    });
    f('}');
    f('');
  }

};


CollectionCType.prototype.emitJsTestImpl = function(f) {
  var type = this;
  f('describe("JSTYPE C++ impl", function() {');

  f('it("should work", function() {');
  if (type.templateName !== 'arma::subview_row' && 
      type.templateName !== 'arma::subview_col' && 
      type.templateName !== 'arma::Mat' && 
      type.templateName !== 'arma::Row') { // WRITEME: implement fromString for Mat and Row
    f('var t1 = ' + type.getExampleValueJs() + ';');
    f('var t1s = t1.toString();');
    if (!type.noSerialize) {
      f('var t2 = ur.JSTYPE.fromString(t1s);');
      f('assert.strictEqual(t1.toString(), t2.toString());');
    }
    
    if (!type.noPacket) {
      f('var t1b = t1.toPacket();');
      f('var t3 = ur.JSTYPE.fromPacket(t1b);');
      f('assert.strictEqual(t1.toString(), t3.toString());');
    }
  }
  f('});');

  if (type.templateName === 'vector' && type.templateArgs[0] === 'double') {
    f('it("should accept vanilla arrays", function() {');
    f('var t1 = new ur.JSTYPE([1.5,2,2.5]);');
    f('t1.pushBack(2.75);');
    f('assert.strictEqual(t1.toJsonString(), "[1.5,2,2.5,2.75]");');
    f('});');

    f('it("should accept Float64 arrays", function() {');
    f('var t1 = new ur.JSTYPE(new Float64Array([1.5,2,2.5]));');
    f('assert.strictEqual(t1.toJsonString(), "[1.5,2,2.5]");');
    f('});');

    f('it("should accept Float32 arrays", function() {');
    f('var t1 = new ur.JSTYPE(new Float32Array([1.5,2,2.5]));');
    f('assert.strictEqual(t1.toJsonString(), "[1.5,2,2.5]");');
    f('});');

    f('it("should allow pushBack", function() {');
    f('var t1 = new ur.JSTYPE();');
    f('t1.pushBack(1.5);');
    f('t1.pushBack(2.5);');
    f('assert.strictEqual(t1.toJsonString(), "[1.5,2.5]");');
    f('});');
  }

  if (type.templateName === 'map' && type.templateArgs[0] === 'string' && type.templateArgs[1] === 'jsonstr') {
    f('it("should accept objects", function() {');
    f('var t1 = new ur.JSTYPE({a: 1, b: "foo",c:{d:1}});');
    f('assert.strictEqual(t1.toJsonString(), "{\\"a\\":1,\\"b\\":\\"foo\\",\\"c\\":{\\"d\\":1}}");');
    f('});');
    
  }


  f('});');

};


/* ----------------------------------------------------------------------
   C Structs. Can be POD or not
*/

function StructCType(reg, typename) {
  CType.call(this, reg, typename);
  this.orderedNames = [];
  this.superTypes = [];
  this.nameToType = {};
  this.nameToInitExpr = {};
  this.extraMemberDecls = [];
  this.matrixStructures = [];
  this.compatCodes = {};
}

StructCType.prototype = Object.create(CType.prototype);
StructCType.prototype.isStruct = true;

StructCType.prototype.addSuperType = function(superTypename) {
  var type = this;
  var superType = type.reg.getType(superTypename);
  if (!superType) throw new Error('No supertype ' + superTypename);
  type.superTypes.push(superType);
};

StructCType.prototype.getConstructorArgs = function() {
  var type = this;
  return [].concat(_.flatten(_.map(type.superTypes, function(superType) {
    return superType.getConstructorArgs();
  }), true), _.map(type.orderedNames, function(memberName) {
    return {name: memberName, type: type.nameToType[memberName]};
  }));
};

StructCType.prototype.hasArrayNature = function() {
  var type = this;
  var mt = type.getMemberTypes();
  return (mt.length === 1);
};

StructCType.prototype.needsDestructor = function() {
  var type = this;
  return type.superTypes.length > 0 || type.extraDestructorCode.length > 0;
};

StructCType.prototype.getFormalParameter = function(varname) {
  var type = this;
  return type.typename + ' const &' + varname;
};

StructCType.prototype.getArgTempDecl = function(varname) {
  var type = this;
  return type.typename + ' &' + varname;
};

StructCType.prototype.getVarDecl = function(varname) {
  var type = this;
  return type.typename + ' ' + varname;
};

StructCType.prototype.getJsToCppTest = function(valueExpr) {
  var type = this;
  return '(JsWrap_' + type.jsTypename + '::Extract(' + valueExpr + ') != nullptr)';
};

StructCType.prototype.getJsToCppExpr = function(valueExpr) {
  var type = this;
  return '(*JsWrap_' + type.jsTypename + '::Extract(' + valueExpr + '))';
};

StructCType.prototype.getCppToJsExpr = function(valueExpr, ownerExpr) {
  var type = this;
  
  if (ownerExpr) {
    return 'JsWrap_' + type.jsTypename + '::MemberInstance(' + ownerExpr + ', &(' + valueExpr + '))';
  } else {
    return 'JsWrap_' + type.jsTypename + '::NewInstance((' + valueExpr + '))';
  }
};

StructCType.prototype.getMembers = function() {
  var type = this;
  return _.map(type.orderedNames, function(memberName) {
    return {memberName: memberName, typename: type.nameToType[memberName].jsTypename};
  });
};

StructCType.prototype.getSynopsis = function() {
  var type = this;
  return '(' + type.typename + '={' + _.map(type.orderedNames, function(name) {
    return type.nameToType[name].getSynopsis();
  }).join(',') + '})';
};

StructCType.prototype.getMemberTypes = function() {
  var type = this;
  var subtypes = sortTypes(_.values(type.nameToType).concat(type.superTypes));
  if (0) console.log('StructCType.getMemberTypes', type.typename, _.map(subtypes, function(type) { return type.typename; }));
  return subtypes
};

StructCType.prototype.getAllZeroExpr = function() {
  return this.typename + '::allZero()';
};
StructCType.prototype.getAllNanExpr = function() {
  return this.typename + '::allNan()';
};

StructCType.prototype.add = function(memberName, memberType) {
  var type = this;
  if (_.isString(memberType)) {
    var newMemberType = type.reg.getNamedType(memberType);
    if (!newMemberType) throw new Error('Unknown member type ' + memberType);
    memberType = newMemberType;
  }
  if (_.isString(memberName)) {
    if (!memberType) memberType = type.reg.types['double'];
    if (memberName in type.nameToType) {
      if (type.nameToType[memberName] !== memberType) throw new Error('Duplicate member ' + memberName + ' with different types');
      return; // duplicate entry. Warn?
    }
    type.nameToType[memberName] = memberType;
    type.orderedNames.push(memberName);
  } else {
    _.each(memberName, function(memberName1) {
      type.add(memberName1, memberType);
    });
  }
};

StructCType.prototype.getMemberInitExpr = function(memberName) {
  var type = this;
  var mType = type.nameToType[memberName];
  if (memberName in type.nameToInitExpr) {
    return type.nameToInitExpr[memberName];
  } else {
    return mType.getInitExpr();
  }
};

StructCType.prototype.emitTypeDecl = function(f) {
  var type = this;
  f('');
  f('struct TYPENAME' + (type.superTypes.length ? ' : ' : '') + _.map(type.superTypes, function(st) {return st.typename;}).join(', ') + ' {');
  f('TYPENAME();'); // declare default constructor
  var constructorArgs = type.getConstructorArgs();
  if (constructorArgs.length) {
    f('TYPENAME(' + _.map(constructorArgs, function(argInfo) {
      return argInfo.type.getFormalParameter('_' + argInfo.name);
    }).join(', ') + ');');
  }
  if (type.needsDestructor()) {
    f('~TYPENAME();');
  }
  
  f('');
  f('// Factory functions');
  if (!type.noStdValues) {
    f('static TYPENAME allZero();');
    f('static TYPENAME allNan();');
  }
  f('TYPENAME copy() const;');
  f('');
  f('// Member variables');
  _.each(type.orderedNames, function(name) {
    type.nameToType[name].emitVarDecl(f, name);
  });


  if (type.hasArrayNature()) {
    f('');
    f('// Array accessors');
    f('typedef ' + type.nameToType[type.orderedNames[0]].typename + ' element_t;');
    f('inline element_t & operator[] (int i) { return (&' + type.orderedNames[0] + ')[i]; }');
    f('inline element_t const & operator[] (int i) const { return (&' + type.orderedNames[0] + ')[i]; }');
  }

  if (type.extraMemberDecls.length) {
    f('');
    f('// From .extraMemberDecls');
    _.each(type.extraMemberDecls, function(l) {
      f(l);
    });
  }

  f('');
  f('// Schema access');
  f('static char const * typeVersionString;');
  f('static char const * typeName;');
  f('static char const * jsTypeName;');
  f('static char const * schema;');
  f('static void addSchemas(map<string, jsonstr> &all);');

  f('};');

  f('char const * getTypeVersionString(TYPENAME const &);');
  f('char const * getTypeName(TYPENAME const &);');
  f('char const * getJsTypeName(TYPENAME const &);');
  f('char const * getSchema(TYPENAME const &);');

  f('');
  f('// IO');
  f('ostream & operator<<(ostream &s, const TYPENAME &obj);');
  if (!type.noSerialize) {
    f('void wrJson(char *&s, const TYPENAME &obj);');
    f('bool rdJson(const char *&s, TYPENAME &obj);');
    f('size_t wrJsonSize(TYPENAME const &x);');
  }

  f('void packet_wr_typetag(packet &p, const TYPENAME &x);');
  f('void packet_rd_typetag(packet &p, TYPENAME &x);');
  f('void packet_wr_value(packet &p, const TYPENAME &x);');
  f('void packet_rd_value(packet &p, TYPENAME &x);');
  
  CType.prototype.emitTypeDecl.call(type, f);
  f('');
};

StructCType.prototype.emitHostImpl = function(f) {
  var type = this;

  if (1) {
    // Default constructor
    f('');
    f('TYPENAME::TYPENAME()');
    if (type.orderedNames.length) {
      f(':' + _.map(type.orderedNames, function(name) {
        return name + '(' + type.getMemberInitExpr(name) + ')';
      }).join(',\n'));
    }
    f('{');
    _.each(type.extraConstructorCode, function(l) {
      f(l);
    });
    f('}');
  }
  f('');

  if (type.needsDestructor()) {
    f('TYPENAME::~TYPENAME() {');
    _.each(type.extraDestructorCode, function(l) {
      f(l);
    });
    f('}');
  }


  var constructorArgs = type.getConstructorArgs();
  if (constructorArgs.length) {
    f('TYPENAME::TYPENAME(' + _.map(constructorArgs, function(argInfo) {
      return argInfo.type.getFormalParameter('_' + argInfo.name);
    }).join(', ') + ')');
    f(':' + [].concat(
      _.map(type.superTypes, function(superType) {
	return superType.typename + '(' + _.map(superType.getConstructorArgs(), function(argInfo) { return '_'+argInfo.name; }).join(', ') + ')';
      }),
      _.map(type.orderedNames, function(name) {
	return name + '(_' + name + ')';
      })).join(', '));
    f('{');
    _.each(type.extraConstructorCode, function(l) {
      f(l);
    });
    f('}');
  }

  if (1) {
    f('');
    f('char const * TYPENAME::typeVersionString = "' + type.getTypeAndVersion() + '";');
    f('char const * TYPENAME::typeName = "TYPENAME";');
    f('char const * TYPENAME::jsTypeName = "' + type.jsTypename + '";');
    f('char const * TYPENAME::schema = "' + cgen.escapeCString(JSON.stringify(type.getSchema())) + '";');


    f('char const * getTypeVersionString(TYPENAME const &it) { return TYPENAME::typeVersionString; }');
    f('char const * getTypeName(TYPENAME const &it) { return TYPENAME::typeName; }');
    f('char const * getJsTypeName(TYPENAME const &it) { return TYPENAME::jsTypeName; }');
    f('char const * getSchema(TYPENAME const &it) { return TYPENAME::schema; }');

  }

  if (1) {
    f('');
    f('void TYPENAME::addSchemas(map<string, jsonstr> &all) {');
    f('if (!all["' + type.jsTypename + '"].isNull()) return;');
    f('all["' + type.jsTypename + '"] = jsonstr(schema);');
    _.each(type.getMemberTypes(), function(type) {
      if (type.isStruct) {
        f(type.typename + '::addSchemas(all); /* ' + type.constructor.name + ' */');
      }
    });
    f('}');
  }

  if (!type.noStdValues && type.isCopyConstructable()) {
    f('');
    f('TYPENAME TYPENAME::allZero() {');
    f('TYPENAME ret;');
    _.each(type.orderedNames, function(name) {
      var memberType = type.nameToType[name];
      f('ret.' + name + ' = ' + memberType.getAllZeroExpr() + ';');
    });
    f('return ret;');
    f('}');
    f('TYPENAME TYPENAME::allNan() {');
    f('TYPENAME ret;');
    _.each(type.orderedNames, function(name) {
      var memberType = type.nameToType[name];
      f('ret.' + name + ' = ' + memberType.getAllNanExpr() + ';');
    });
    f('return ret;');
    f('}');
  }

  if (1) {
    f('');
    f('ostream & operator<<(ostream &s, const TYPENAME &obj) {');
    f('s << "' + type.typename + '{";');
    _.each(type.orderedNames, function(name, namei) {
      if (type.nameToType[name].isCollection) {
        f('s << "' + (namei > 0 ? ', ' : '') + name + '=" << asJson(obj.' + name + ');');
      } else {
        f('s << "' + (namei > 0 ? ', ' : '') + name + '=" << obj.' + name + ';');
      }
    });
    f('s << "}";');
    f('return s;');
    f('}');
  }

  f('');
  if (!type.noSerialize) {
    type.emitWrJson(f);
    f('');
    type.emitRdJson(f);
    f('');
    type.emitPacketIo(f);
  }
};

StructCType.prototype.getExampleValueJs = function() {
  var type = this;
  return 'new ur.' + type.jsTypename + '(' + _.map(type.orderedNames, function(name) {
    return type.nameToType[name].getExampleValueJs();
  }).join(', ') + ')';
};

StructCType.prototype.emitJsTestImpl = function(f) {
  var type = this;
  if (type.superTypes.length) return; // WRITEME: this gets pretty complicated...
  f('describe("JSTYPE C++ impl", function() {');

  f('it("should work", function() {');
  f('var t1 = ' + type.getExampleValueJs() + ';');
  f('var t1s = t1.toString();');
  f('var t2 = ur.JSTYPE.fromString(t1s);');
  f('assert.strictEqual(t1.toString(), t2.toString());');

  if (!type.noPacket) {
    f('var t1b = t1.toPacket();');
    f('var t3 = ur.JSTYPE.fromPacket(t1b);');
    f('assert.strictEqual(t1.toString(), t3.toString());');
  }
  f('});');

  if (0 && !type.noPacket) {
    f('it("fromPacket should be fuzz-resistant", function() {');
    f('var t1 = ' + type.getExampleValueJs() + ';');
    f('var bufLen = t1.toPacket().length;');
    f('for (var i=0; i<bufLen; i++) {');
    f('for (var turd=0; turd<256; turd++) {');
    f('var t1buf = t1.toPacket();');
    f('t1buf.writeUInt8(turd, i);');
    f('try {');
    f('var t2 = ur.TestStruct.fromPacket(t1buf);');
    f('} catch(ex) {');
    f('}');
    f('}');
    f('}');
    f('});');
  }
  f('});');
};

// Packet
StructCType.prototype.emitPacketIo = function(f) {
  var type = this;

  f('void packet_wr_typetag(packet &p, const TYPENAME &x) {');
  f('p.add_typetag(x.typeVersionString);');
  f('}');

  // WRITEME maybe: for POD types, consider writing directly
  f('void packet_wr_value(packet &p, const TYPENAME &x) {');
  _.each(type.orderedNames, function(name) {
    if (!type.nameToType[name].isPtr()) {
      f('packet_wr_value(p, x.' + name + ');');
    }
  });
  f('}');

  f('void packet_rd_typetag(packet &p, TYPENAME &x) {');
  f('p.check_typetag(x.typeVersionString);');
  f('}');

  f('void packet_rd_value(packet &p, TYPENAME &x) {');
  _.each(type.orderedNames, function(name) {
    if (!type.nameToType[name].isPtr()) {
      f('packet_rd_value(p, x.' + name + ');');
      }
  });
  f('}');
  
};


// JSON

StructCType.prototype.emitWrJson = function(f) {
  var type = this;
  function emitstr(s) {
    var b = new Buffer(s, 'utf8');
    f(_.map(_.range(0, b.length), function(ni) {
      return '*s++ = ' + b[ni]+ ';';
    }).join(' ') + ' // ' + cgen.escapeCString(s));
  }
  f('void wrJson(char *&s, const TYPENAME &obj) {');
  emitstr('{"__type":"' + type.jsTypename + '"');
  _.each(type.orderedNames, function(name, namei) {
    emitstr(',\"' + name + '\":');
    f('wrJson(s, obj.' + name + ');');
  });
  f('*s++ = \'}\';');
  f('}');

  f('size_t wrJsonSize(const TYPENAME &obj) {');
  f('return 12 + ' + (new Buffer(type.typename, 'utf8').length).toString() + ' + ' + _.map(type.orderedNames, function(name, namei) {
    return (new Buffer(name, 'utf8').length + 4).toString() + '+wrJsonSize(obj.' + name + ')';
  }).join(' + ') + ' + 1;');
  f('}');
};

StructCType.prototype.emitRdJson = function(f) {
  var type = this;
  var actions = {};
  actions['}'] = function() {
    f('return typeOk;');
  };
  _.each(type.orderedNames, function(name) {
    if (!type.nameToType[name].isPtr()) {
      actions['"' + name + '":'] = function() {
	f('if (rdJson(s, obj.' + name + ')) {');
	f('jsonSkipSpace(s);');
	f('c = *s++;');
	f('if (c == \',\') continue;');
	f('if (c == \'}\') return typeOk;');
	f('}');
      };
    };
  });
  actions['"__type":"' + type.jsTypename + '"'] = function() {
    f('typeOk = true;');
    f('c = *s++;');
    f('if (c == \',\') continue;');
    f('if (c == \'}\') return typeOk;');
  };
  
  f('bool rdJson(char const *&s, TYPENAME &obj) {');
  f('bool typeOk = false;');
  f('char c;');
  f('jsonSkipSpace(s);');
  f('c = *s++;');
  f('if (c == \'{\') {');
  f('while(1) {');
  f('jsonSkipSpace(s);');
  f('char const *memberStart = s;');
  f('c = *s++;');
  emitPrefix('');
  f('s = memberStart;');
  f('if (!jsonSkipMember(s)) return false;');
  f('c = *s++;');
  f('if (c == \',\') continue;');
  f('if (c == \'}\') return typeOk;');
  f('}');
  f('}');
  f('s--;');
  if (debugJson) f('eprintf("rdJson fail at %s\\n", s);');
  f('return false;');
  f('}');

  
  function emitPrefix(prefix) {
    
    // O(n^2), not a problem with current structures but could be with 1000s of members
    var nextChars = [];
    _.each(actions, function(action, name) {
      if (name.length > prefix.length &&
          name.substr(0, prefix.length) === prefix) {
        nextChars.push(name.substr(prefix.length, 1));
      }
    });

    nextChars = _.uniq(nextChars);

    var ifCount = 0;
    _.each(nextChars, function(nextChar) {
      f((ifCount ? 'else if' : 'if') + ' (c == \'' + (nextChar === '\"' ? '\\' : '') + nextChar + '\') {');
      ifCount++;
      var augPrefix = prefix + nextChar;
      if (augPrefix in actions) {
        actions[augPrefix]();
      } else {
        f('c = *s++;');
        emitPrefix(augPrefix);
      }
      f('}');
    });
  }
};

StructCType.prototype.hasJsWrapper = function(f) {
  return true;
};

StructCType.prototype.emitJsWrapDecl = function(f) {
  var type = this;
  f('typedef JsWrapGeneric< TYPENAME > JsWrap_JSTYPE;');
  f('Handle<Value> jsConstructor_JSTYPE(JsWrap_JSTYPE *it, const Arguments &args);');
  f('Handle<Value> jsToJSON_JSTYPE(TYPENAME const &it);');
};

StructCType.prototype.emitJsWrapImpl = function(f) {
  var type = this;
  var methods = [];
  var factories = [];
  var accessors = [];

  if (1) {
    f('static Handle<Value> jsNew_JSTYPE(const Arguments& args) {');
    f('HandleScope scope;');
    f('if (!(args.This()->InternalFieldCount() > 0)) return ThrowInvalidThis();');
    f('JsWrap_JSTYPE* thisObj = new JsWrap_JSTYPE();');
    f('return jsConstructor_JSTYPE(thisObj, args);');
    f('}');
    f('');
  }

  if (1) {
    f('Handle<Value> jsConstructor_JSTYPE(JsWrap_JSTYPE *thisObj, const Arguments& args) {');
    f('HandleScope scope;');

    var constructorArgs = type.getConstructorArgs();
    emitArgSwitch(f, type.reg, null, [
      {args: [], code: function() {
	f('thisObj->assignDefault();');
      }},
      {args: _.map(constructorArgs, function(argInfo) { return argInfo.type; }), code: function() {
	f('thisObj->assignConstruct(' + _.map(constructorArgs, function(argInfo, argi) {
	  return 'a'+argi;
	}) + ');');
      }}
    ]);

    f('thisObj->Wrap2(args.This());');
    f('return args.This();');
    f('}');
  }

  if (!type.noSerialize) {
    
    f('Handle<Value> jsToJSON_JSTYPE(const TYPENAME &it) {');
    f('if (fastJsonFlag) {');
    f('string fjbItem = asJson(it).it;');
    f('if (fjbItem.size() > 20) {');
    f('Local<Object> ret = Object::New();');
    f('ret->Set(String::NewSymbol("__wsType"), String::New("jsonString"));');
    f('ret->Set(String::NewSymbol("json"), convStringToJs(fjbItem));');
    f('return ret;');
    f('}');
    f('}');

    f('Local<Object> ret = Object::New();');
    
    f('ret->Set(String::NewSymbol("__type"), String::NewSymbol("JSTYPE"));');
    _.each(type.orderedNames, function(name) {
      var memberType = type.nameToType[name];
      if (!memberType.isPtr()) {
	switch (memberType.typename) {
	case 'int': 
	case 'u_int': 
	case 'float': 
	case 'double':
          f('ret->Set(String::NewSymbol("' + name + '"), Number::New(it.' + name + '));');
          break;
	case 'bool':
          f('ret->Set(String::NewSymbol("' + name + '"), Boolean::New(it.' + name + '));');
          break;
	case 'string':
          f('ret->Set(String::NewSymbol("' + name + '"), convStringToJs(it.' + name + '));');
          break;
	case 'jsonstr':
          f('ret->Set(String::NewSymbol("' + name + '"), convJsonstrToJs(it.' + name + '));');
          break;
	default:
          f('ret->Set(String::NewSymbol("' + name + '"), jsToJSON_' + memberType.jsTypename + '(it.' + name + '));');
	}
      }
    });
    f('return ret;');
    f('}');

    emitJsWrap(f, 'JSTYPE_toJSON', function() {
      emitArgSwitch(f, type.reg, type, [{
        args: [], ignoreExtra: true, code: function() {
          f('return scope.Close(jsToJSON_JSTYPE(*thisObj->it));');
        }
      }]);
    });
    methods.push('toJSON');
  }

  if (!type.noSerialize) {
    emitJsWrap(f, 'JSTYPE_toJsonString', function() {
      emitArgSwitch(f, type.reg, type, [{
        args: [], returnType: 'string', code: function() {
          f('ret = asJson(*thisObj->it).it;');
        }
      }]);
    });
    methods.push('toJsonString');

    emitJsWrap(f, 'JSTYPE_inspect', function() {
      emitArgSwitch(f, type.reg, type, [{
        // It's given an argument, recurseTimes, which we should decrement when recursing but we don't.
        args: ['double'], returnType: 'string', code: function() {
          f('if (a0 >= 0) ret = asJson(*thisObj->it).it;');
        }
      }]);
    });
    methods.push('inspect');

    emitJsWrap(f, 'JSTYPE_toJsonBuffer', function() {
      emitArgSwitch(f, type.reg, type, [{
        args: [], returnType: 'buffer', code: function() {
          f('ret = asJson(*thisObj->it).it;');
        }
      }]);
    });
    methods.push('toJsonBuffer');

    emitJsWrap(f, 'JSTYPE_fromString', function() {
      emitArgSwitch(f, type.reg, null, [
        {args: ['string'], returnType: type, code: function() {
          f('const char *a0s = a0.c_str();');
          f('bool ok = rdJson(a0s, ret);');
          f('if (!ok) return ThrowInvalidArgs();');
        }}
      ]);
    });
    factories.push('fromString');
  }

  if (!type.noPacket) {
    emitJsWrap(f, 'JSTYPE_toPacket', function() {
      emitArgSwitch(f, type.reg, type, [
        {args: [], code: function() {
          f('packet wr;');
          f('wr.add_checked(*thisObj->it);');
          f('node::Buffer *buf = node::Buffer::New((const char *)wr.rd_ptr(), wr.size());');
          f('return scope.Close(Handle<Object>(buf->handle_));');
        }}
      ]);
    });
    methods.push('toPacket');

    emitJsWrap(f, 'JSTYPE_fromPacket', function() {
      emitArgSwitch(f, type.reg, null, [{
        args: ['string'], returnType: type, code: function() {
          f('packet rd(a0);');
          f('try {');
          f('rd.get_checked(ret);');
          f('} catch(exception &ex) {');
          f('return ThrowTypeError(ex.what());');
          f('};');
        }}]);
    });
    factories.push('fromPacket');
  }

  if (!type.noStdValues && type.isCopyConstructable()) {
    _.each(['allZero', 'allNan'], function(name) {
      f('static Handle<Value> jsWrap_JSTYPE_' + name + '(const Arguments& args) {');
      f('HandleScope scope;');
      f('return scope.Close(JsWrap_JSTYPE::NewInstance(TYPENAME::' + name + '()));');
      f('}');
      factories.push(name);
    });
  }

  _.each(type.orderedNames, function(name) {
    var memberType = type.nameToType[name];
    f('static Handle<Value> jsGet_JSTYPE_' + name + '(Local<String> name, AccessorInfo const &ai) {');
    f('HandleScope scope;');
    f('JsWrap_JSTYPE* thisObj = node::ObjectWrap::Unwrap<JsWrap_JSTYPE>(ai.This());');
    f('return scope.Close(' + memberType.getCppToJsExpr((memberType.isPtr() ? '*' : '') + 'thisObj->it->' + name, 'thisObj->it') + ');');
    f('}');

    f('static void jsSet_JSTYPE_' + name + '(Local<String> name, Local<Value> value, AccessorInfo const &ai) {');
    f('HandleScope scope;');
    f('JsWrap_JSTYPE* thisObj = node::ObjectWrap::Unwrap<JsWrap_JSTYPE>(ai.This());');
    f('if (' + memberType.getJsToCppTest('value') + ') {');
    f('thisObj->it->' + name + ' = ' + memberType.getJsToCppExpr('value') + ';');
    f('}');
    f('else {');
    f('ThrowTypeError("Expected ' + memberType.typename + '");');
    f('}');
    f('}');
    f('');
    accessors.push(name);
  });

  if (1) { // Setup template and prototype
    f('void jsInit_JSTYPE(Handle<Object> exports) {');
    f('Local<FunctionTemplate> tpl = FunctionTemplate::New(jsNew_JSTYPE);');
    f('tpl->SetClassName(String::NewSymbol("JSTYPE"));');
    f('tpl->InstanceTemplate()->SetInternalFieldCount(1);');

    _.each(methods, function(name) {
      f('tpl->PrototypeTemplate()->Set(String::NewSymbol("' + name + '"), FunctionTemplate::New(jsWrap_JSTYPE_' + name + ')->GetFunction());');
    });
    if (!type.noSerialize) {
      f('tpl->PrototypeTemplate()->Set(String::NewSymbol("toString"), FunctionTemplate::New(jsWrap_JSTYPE_toJsonString)->GetFunction());');
    }

    _.each(accessors, function(name) {
      var memberType = type.nameToType[name];
      f('tpl->PrototypeTemplate()->SetAccessor(String::NewSymbol("' + name + '"), ' +
        '&jsGet_JSTYPE_' + name + ', ' +
        '&jsSet_JSTYPE_' + name + ');');
    });
    f('');
    
    f('JsWrap_JSTYPE::constructor = Persistent<Function>::New(tpl->GetFunction());');
    f('exports->Set(String::NewSymbol("JSTYPE"), JsWrap_JSTYPE::constructor);');
    _.each(factories, function(name) {
      f('JsWrap_JSTYPE::constructor->Set(String::NewSymbol("' + name + '"), FunctionTemplate::New(jsWrap_JSTYPE_' + name + ')->GetFunction());');
    });
    f('}');
    f('');
  }

};

// ----------------------------------------------------------------------

function PtrCType(reg, baseType) {
  var type = this;
  type.baseType = baseType;
  CType.call(type, reg, baseType.typename + '*');
  type.jsTypename = baseType.jsTypename;
}
PtrCType.prototype = Object.create(CType.prototype);

PtrCType.prototype.nonPtrType = function() {
  return this.baseType;
};

PtrCType.prototype.getFns = function() {
  return {};
};

PtrCType.prototype.getSynopsis = function() {
  return '(' + this.typename + ')';
};

PtrCType.prototype.getAllOneExpr = function() {
  return 'nullptr';
};

PtrCType.prototype.getAllZeroExpr = function() {
  return 'nullptr';
};

PtrCType.prototype.getAllNanExpr = function() {
  return 'nullptr';
};

PtrCType.prototype.getExampleValueJs = function() {
  return 'null';
};

PtrCType.prototype.isPtr = function() {
  return true;
};

PtrCType.prototype.emitVarDecl = function(f, varname) {
  var type = this;
  f('shared_ptr<' + type.baseType.typename + '> ' + varname + ';');
};

PtrCType.prototype.getFormalParameter = function(varname) {
  var type = this;
  return 'shared_ptr<' + type.baseType.typename + '> ' + varname;
};

PtrCType.prototype.getArgTempDecl = function(varname) {
  var type = this;
  return 'shared_ptr<' + type.baseType.typename + '> ' + varname;
};

PtrCType.prototype.getVarDecl = function(varname) {
  var type = this;
  return 'shared_ptr<' + type.baseType.typename + '> ' + varname;
};

PtrCType.prototype.getJsToCppTest = function(valueExpr) {
  var type = this;
  return '(JsWrap_' + type.jsTypename + '::Extract(' + valueExpr + ') != nullptr)';
};

PtrCType.prototype.getJsToCppExpr = function(valueExpr) {
  var type = this;
  return 'JsWrap_' + type.jsTypename + '::Extract(' + valueExpr + ')';
};

PtrCType.prototype.getCppToJsExpr = function(valueExpr, ownerExpr) {
  var type = this;
  if (ownerExpr) {
    return 'JsWrap_' + type.jsTypename + '::MemberInstance(' + ownerExpr + ', &(' + valueExpr + '))';
  } else {
    return 'JsWrap_' + type.jsTypename + '::NewInstance(' + valueExpr + ')';
  }
};


// ----------------------------------------------------------------------

function CDspType(reg, lbits, rbits) {
  var type = this;
  type.lbits = lbits;
  type.rbits = rbits;
  type.tbits = lbits + rbits;

  var typename = 'dsp' + lbits.toString() + rbits.toString();
  CType.call(type, reg, typename);
}
CDspType.prototype = Object.create(CType.prototype);

CDspType.prototype.getFns = function() {
  var type = this;
  return {};
};

CDspType.prototype.getSynopsis = function() {
  var type = this;
  return '(' + type.typename + ')';
};

CDspType.prototype.getHeaderIncludes = function() {
  var type = this;
  return ['#include "tlbcore/common/dspcore.h"'].concat(CType.prototype.getHeaderIncludes.call(type));
};

CDspType.prototype.getAllOneExpr = function() {
  var type = this;
  switch (type.tbits) {
  case 16:
  case 32:
    return '(1<<' + type.rbits + ')';
  case 64:
    return '(1LL<<' + type.rbits + ')';
  default:
    return '***ALL_ONE***';
  }
};

CDspType.prototype.getAllZeroExpr = function() {
  var type = this;
  return '0';
};

CDspType.prototype.getAllNanExpr = function() {
  var type = this;
  switch (type.tbits) {
  case 16:
    return '0x800';
  case 32:
    return '0x80000000';
  case 64:
    return '0x8000000000000000LL';
  default:
    return '***ALL_NAN***';
  }
};
