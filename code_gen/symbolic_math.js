/*
  A way of building up arithmetic formulas in JS that can be emitted as C++ code,
  or directly evaluated.
*/
var _                   = require('underscore');
var util                = require('util');
var cgen                = require('./cgen');
var assert              = require('assert');
var crypto              = require('crypto');

exports.defop = defop;
exports.SymbolicContext = SymbolicContext;

var defops = {};

function defop(retType, op /*, argTypes..., impl */) {
  var argTypes = [];
  for (var argi=2; argi + 1 < arguments.length; argi++) argTypes.push(arguments[argi]);
  
  if (!defops[op]) defops[op] = [];
  defops[op].push({
    retType: retType,
    argTypes: argTypes,
    impl: arguments[arguments.length - 1]
  });
}


function simpleHash(s) {
  var h = crypto.createHmac('sha1', 'key');
  h.update(s);
  return h.digest('hex').substr(0, 16);
}


function SymbolicContext(typereg) {
  var c = this;
  c.typereg = typereg;
  c.cses = {};
}

SymbolicContext.prototype.dedup = function(e) {
  var c = this;
  assert.strictEqual(e.c, c);
  var cse = c.cses[e.cseKey];
  if (cse) return cse;
  c.cses[e.cseKey] = e;
  return e;
};


SymbolicContext.prototype.V = function(type, name) {
  var c = this;
  return c.dedup(new SymbolicVar(c, type, name));
};

SymbolicContext.prototype.A = function(name, value) {
  var c = this;
  return c.dedup(new SymbolicAssign(c, 
                                    value.type,
                                    name,
                                    value));
};

SymbolicContext.prototype.C = function(type, value) {
  var c = this;
  return c.dedup(new SymbolicConst(c, type, value));
};

SymbolicContext.prototype.E = function(op /*, args... */) {
  var c = this;
  var args = [];
  for (var argi=1; argi < arguments.length; argi++) args.push(arguments[argi]);
  _.each(args, function(arg) {
    assert.strictEqual(arg.c, c);
  });
  return c.dedup(new SymbolicExpr(c, op, args));
};

SymbolicContext.prototype.D = function(wrt, e) {
  var c = this;
  assert.strictEqual(wrt.c, c);
  assert.strictEqual(e.c, c);
  if (e instanceof SymbolicVar) {
    if (e === wrt) {
      return c.C(e.type, 1);
    } else {
      return c.C(e.type, 0);
    }
  }
  else if (e instanceof SymbolicConst) {
    return c.C(e.type, 0);
  }
  else if (e instanceof SymbolicExpr) {
    return e.opInfo.impl.deriv.apply(e, [wrt].concat(e.args));
  }
  else {
    throw new Error('Unknown expression type ' + e.toString());
  }
};


SymbolicContext.prototype.getCExpr = function(e, availCses) {
  var c = this;
  assert.strictEqual(e.c, c);
  if (e instanceof SymbolicVar) {
    return e.name;
  }
  else if (e instanceof SymbolicConst) {
    if (e.type === 'double' || e.type === 'int') {
      return e.value.toString();
    }
    // Handle more cases
    return '(' + e.type + ' { ' + e.value.toString() + ' })';
  }
  else if (e instanceof SymbolicExpr) {
    if (availCses && availCses[e.cseKey]) {
      return e.cseKey;
    }
    var argExprs = _.map(e.args, function(arg) {
      return c.getCExpr(arg, availCses);
    });
    return e.opInfo.impl.c.apply(e, argExprs);
  }
  else {
    throw new Error('Unknown expression type ' + e.toString());
  }
};

SymbolicContext.prototype.getImm = function(e, vars) {
  var c = this;
  assert.strictEqual(e.c, c);
  if (e instanceof SymbolicVar) {
    return vars[e.name];
  }
  else if (e instanceof SymbolicConst) {
    // WRITEME: needs work for arma::mat & other non-immediate types
    return e.value;
  }
  else if (e instanceof SymbolicExpr) {
    var argExprs = _.map(e.args, function(arg) {
      return c.getImm(arg, vars);
    });
    return e.opInfo.impl.imm.apply(e, argExprs);
  }
  else {
    throw new Error('Unknown expression type ' + e.toString());
  }
};

SymbolicContext.prototype.getCosts = function(e, costs) {
  var c = this;
  assert.strictEqual(e.c, c);
  if (costs[e.cseKey]) {
    costs[e.cseKey] += e.cseCost;
  } else {
    costs[e.cseKey] = e.cseCost;
    if (e instanceof SymbolicExpr) {
      _.each(e.args, function(arg) {
        c.getCosts(arg, costs);
      });
    }
    else if (e instanceof SymbolicAssign) {
      c.getCosts(e.value, costs);
    }
  }
};

SymbolicContext.prototype.emitCppCses = function(e, f, availCses, costs) {
  var c = this;
  assert.strictEqual(e.c, c);
  if (e instanceof SymbolicExpr) {
    if (!availCses[e.cseKey]) {
      _.each(e.args, function(arg) {
        c.emitCppCses(arg, f, availCses, costs);
      });
      if ((costs[e.cseKey] || 0) >= 1) {
        // Wrong for composite types, use TypeRegistry
        f(e.type + ' ' + e.cseKey + ' = ' + c.getCExpr(e, availCses) + ';');
        availCses[e.cseKey] = true;
      }
    }
  }
  else if (e instanceof SymbolicAssign) {
    c.emitCppCses(e.value, f, availCses, costs);
  }
};

SymbolicContext.prototype.emitCpp = function(f, assigns) {
  var c = this;
  var costs = {};
  var availCses = {};
  _.each(assigns, function(a) {
    c.getCosts(a, costs);
    c.emitCppCses(a, f, availCses, costs);
  });
  _.each(assigns, function(a) {
    f(a.name + ' = ' + c.getCExpr(a.value, availCses) + ';');  
  });
  
};



// ----------------------------------------------------------------------

function SymbolicAssign(c, type, name, value) {
  var e = this;
  e.c = c;
  e.type = type;
  e.name = name;
  e.value = value;
  e.cseKey = 'A' + simpleHash(e.type + ',' + e.name + ',' + value.cseKey);
  e.cseCost = 1.0;
}

function SymbolicVar(c, type, name) {
  var e = this;
  e.c = c;
  e.type = type;
  e.name = name;
  e.cseKey = 'V' + simpleHash(e.type + ',' + e.name);
  e.cseCost = 0.25;
}

function SymbolicConst(c, type, value) {
  var e = this;
  e.c = c;
  e.type = type;
  e.value = value;
  e.cseKey = 'C' + simpleHash(e.type + ',' + e.value.toString());
  e.cseCost = 0.25;
}

function SymbolicExpr(c, op, args) {
  var e = this;
  e.c = c;
  e.op = op;
  e.args = args;
  if (!defops[op]) {
    throw new Error('No op ' + op);
  }
  e.opInfo = _.find(defops[op], function(opInfo) {
    return opInfo.argTypes.length == args.length && _.every(_.range(opInfo.argTypes.length), function(argi) {
      return args[argi].type == opInfo.argTypes[argi];
    });
  });
  if (!e.opInfo) {
    throw new Error('Could not deduce arg types for ' + op + ' ' + _.map(args, function (arg) {
      return arg.type; }).join(' '));
  }
  e.type = e.opInfo.retType;
  e.cseKey = 'E' + simpleHash(e.type + ',' + e.op + ',' + _.map(e.args, function(arg) { return arg.cseKey; }).join(','));
  e.cseCost = 0.5;
}



defop('double',  'pow',     	'double', 'double', {
  imm: function(a, b) { return Math.pow(a,b); },
  c: function(a, b) { return 'pow(' + a + ',' + b + ')'; },
});
defop('double',  'sin',     	'double', {
  imm: function(a) { return Math.sin(a); },
  c: function(a) { return 'sin(' + a + ')'; },
  deriv: function(a) {
    return this.c.E('*',
		    this.c.D(wrt, a),
		    this.c.E('cos', a));
  },
});
defop('double',  'cos',     	'double', {
  imm: function(a) { return Math.cos(a); },
  c: function(a) { return 'cos(' + a + ')'; },
  deriv: function(a) {
    return this.c.E('*',
		    this.c.C('double', '-1'),
		    this.c.E('*',
			     this.c.D(wrt, a),
			     this.c.E('sin', a)));
  },
});
defop('double',  'tan',     	'double', {
  imm: function(a) { return Math.tan(a); },
  c: function(a) { return 'tan(' + a + ')'; },
});
defop('double',  'exp',     	'double', {
  imm: function(a) { return Math.exp(a); },
  c: function(a) { return 'exp(' + a + ')'; },
  deriv: function(a) {
    return this.c.E('*',
		    this.c.D(wrt, a),
		    this);
  },
});
defop('double',  'log',     	'double', {
  imm: function(a) { return Math.log(a); },
  c: function(a) { return 'log(' + a + ')'; },
});

defop('double',  '*',       	'double', 'double', {
  imm: function(a, b) { return a * b; },
  c: function(a, b) { return '(' + a + ' * ' + b + ')'; },
  deriv: function(wrt, a, b) {
    return this.c.E('+',
		    this.c.E('*', a, this.c.D(wrt, b)),
		    this.c.E('*', b, this.c.D(wrt, a)));
  },
});
defop('double',  '+',       	'double', 'double', {
  imm: function(a, b) { return a + b; },
  c: function(a, b) { return '(' + a + ' + ' + b + ')'; },
  deriv: function(wrt, a, b) {
    return this.c.E('+', this.c.D(wrt, a), this.c.D(wrt, b));
  },
});
defop('double',  '-',       	'double', 'double', {
  imm: function(a, b) { return a - b; },
  c: function(a, b) { return '(' + a + ' - ' + b + ')'; },
  deriv: function(wrt, a, b) {
    return this.c.E('-', this.c.D(wrt, a), this.c.D(wrt, b));
  },
});
defop('double',  '/',       	'double', 'double', {
  imm: function(a, b) { return a / b; },
  c: function(a, b) { return '(' + a + ' / ' + b + ')'; },
});
defop('double',  'min',     	'double', 'double', {
  imm: function(a, b) { return Math.min(a, b); },
  c: function(a, b) { return 'min(' + a + ', ' + b + ')'; },
});
defop('double',  'max',     	'double', 'double', {
  imm: function(a, b) { return Math.max(a, b); },
  c: function(a, b) { return 'max(' + a + ', ' + b + ')'; },
});

defop('int',     '*',           'int', 'int', {
  imm: function(a, b) { return a * b; },
  c: function(a, b) { return '(' + a + ' * ' + b + ')'; }
});
defop('int',  	 '+', 	        'int', 'int', {
  imm: function(a, b) { return a + b; },
  c: function(a, b) { return '(' + a + ' + ' + b + ')'; },
});
defop('int',  	 '-', 	        'int', 'int', {
  imm: function(a, b) { return a - b; },
  c: function(a, b) { return '(' + a + ' - ' + b + ')'; },
});
defop('int',  	 '/', 	        'int', 'int', {
  imm: function(a, b) { var r = a / b; return (r < 0) ? Math.ceil(r) : Math.floor(r); }, // Math.trunc not widely supported
  c: function(a, b) { return '(' + a + ' / ' + b + ')'; },
});
defop('int',  	 'min',         'int', 'int', {
  imm: function(a, b) { return Math.min(a, b); },
  c: function(a, b) { return 'min(' + a + ', ' + b + ')'; },
});
defop('int',  	 'max',         'int', 'int', {
  imm: function(a, b) { return Math.max(a, b); },
  c: function(a, b) { return 'max(' + a + ', ' + b + ')'; },
});

defop('double',  '(double)',    'int', {
  imm: function(a) { return a; },
  c: function(a) { return '(double)' + a; },
});
defop('int',     '(int)',       'double', {
  imm: function(a) { return a; },
  c: function(a) { return '(int)' + a; },
});

if (0) {
defop('double',  'sigmoid_01',  'double')
defop('double',  'sigmoid_11',  'double')
defop('double',  'sigmoid_22',  'double')
}

defop('double',  'sqrt',        'double', {
  imm: function(a) { return Math.sqrt(a); },
  c: function(a) { return 'sqrt(' + a + ')'; },
});

defop('double',  'jointRange',        'double', 'double', 'double', {
  imm: function(a, b, c) { return b + a*(c-b); },
  c: function(a) { return '(' + b + ' + ' + a + ' * (' + c + ' - ' + b + '))'; },
});

defop('arma::mat3',    'mat3RotationZ',   'double', {
  imm: function(a) {
    var ca = Math.cos(a);
    var sa = Math.sin(a);
    return [[ca, sa, 0],
	    [-sa, ca, 0],
	    [0, 0, 1]];
  },
  c: function(a) {
    return 'arma::mat3 { cos(' + a + '), sin(' + a + '), 0, -sin(' + a + '), cos(' + a + '), 0, 0, 0, 1 }';
  },
});
defop('arma::mat4',        'mat4RotationZ',   'double', {
  imm: function(a) {
    var ca = Math.cos(a);
    var sa = Math.sin(a);
    return [[ca, sa, 0, 0],
	    [-sa, ca, 0, 0],
	    [0, 0, 1, 0],
	    [0, 0, 0, 1]];
  },
  c: function(a) {
    return 'arma::mat4 { cos(' + a + '), sin(' + a + '), 0, 0, -sin(' + a + '), cos(' + a + '), 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 }';
  },
});

defop('arma::mat4',        'mat4Translation',   'double', 'double', 'double', {
  imm: function(x, y, z) {
    return [[1, 0, 0, x],
	    [0, 1, 0, y],
	    [0, 0, 1, z],
	    [0, 0, 0, 1]];
  },
  c: function(x, y, z) {
    return 'arma::mat4 { 1, 0, 0, ' + x + ', 0, 1, 0, ' + y + ', 0, 0, 1, ' + z + ', 0, 0, 0, 1 }';
  },
});

defop('arma::mat4',    '*',           'arma::mat4', 'arma::mat4', {
  c: function(a, b) {
    return '(' + a + ' * ' + b + ')';
  },
});

defop('arma::mat4',    '+',           'arma::mat4', 'arma::mat4', {
  c: function(a, b) {
    return '(' + a + ' + ' + b + ')';
  },
});


if (0) {
defop('double',        'at',          'arma::mat2', 'int', 'int')
defop('double',        'at',          'arma::mat3', 'int', 'int')
defop('double',        'at',          'arma::mat4', 'int', 'int')

defop('double',        'at',          'arma::vec2', 'int')
defop('double',        'at',          'arma::vec3', 'int')
defop('double',        'at',          'arma::vec4', 'int')

defop('arma::mat2',    '*',           'arma::mat2', 'arma::mat2')
defop('arma::mat3',    '*',           'arma::mat3', 'arma::mat3')

defop('arma::mat2',    '+',           'arma::mat2', 'arma::mat2')
defop('arma::mat3',    '+',           'arma::mat3', 'arma::mat3')
defop('arma::mat4',    '+',           'arma::mat4', 'arma::mat4')

defop('arma::mat2',    '-',           'arma::mat2', 'arma::mat2')
defop('arma::mat3',    '-',           'arma::mat3', 'arma::mat3')
defop('arma::mat4',    '-',           'arma::mat4', 'arma::mat4')

defop('arma::vec2',    '*',           'arma::vec2', 'arma::vec2')
defop('arma::vec3',    '*',           'arma::vec3', 'arma::vec3')
defop('arma::vec4',    '*',           'arma::vec4', 'arma::vec4')

defop('arma::vec2',    '+',           'arma::vec2', 'arma::vec2')
defop('arma::vec3',    '+',           'arma::vec3', 'arma::vec3')
defop('arma::vec4',    '+',           'arma::vec4', 'arma::vec4')

defop('arma::vec2',    '-',           'arma::vec2', 'arma::vec2')
defop('arma::vec3',    '-',           'arma::vec3', 'arma::vec3')
defop('arma::vec4',    '-',           'arma::vec4', 'arma::vec4')

defop('arma::mat3',    'inverse',     'arma::mat3')
defop('arma::mat4',    'inverse',     'arma::mat4')
defop('arma::mat3',    'transpose',   'arma::mat3')

defop('arma::mat2',    '*',           'arma::mat2', 'double')
defop('arma::mat3',    '*',           'arma::mat3', 'double')
defop('arma::mat4',    '*',           'arma::mat4', 'double')

defop('arma::vec2',    '*',           'arma::mat2', 'arma::vec2')
defop('arma::vec3',    '*',           'arma::mat3', 'arma::vec3')
defop('arma::vec3',    '*',           'arma::mat4', 'arma::vec3')
defop('arma::vec4',    '*',           'arma::mat4', 'arma::vec4')
 
defop('arma::vec2',    '*',           'arma::vec2', 'double')
defop('arma::vec3',    '*',           'arma::vec3', 'double')
defop('arma::vec4',    '*',           'arma::vec4', 'double')

defop('arma::vec2',    '*',           'double', 'arma::vec2')
defop('arma::vec3',    '*',           'double', 'arma::vec3')
defop('arma::vec4',    '*',           'double', 'arma::vec4')

defop('arma::vec3',    'cross',       'arma::vec3', 'arma::vec3')
defop('float',         'dot',         'arma::vec3', 'arma::vec3')

}