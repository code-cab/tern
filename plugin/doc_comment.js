// Parses comments above variable declarations, function declarations,
// and object properties as docstrings and JSDoc-style type
// annotations.
(function (mod) {
    if (typeof exports == "object" && typeof module == "object") // CommonJS
        return mod(require("../lib/infer"), require("../lib/tern"), require("../lib/comment"),
            require("acorn"), require("acorn-walk"), require('doctrine'));
    if (typeof define == "function" && define.amd) // AMD
        return define(["../lib/infer", "../lib/tern", "../lib/comment", "acorn/dist/acorn", "acorn-walk/dist/walk", "doctrine"], mod);
    mod(tern, tern, tern.comment, acorn, acorn.walk, doctrine);
})(function (infer, tern, comment, acorn, walk, doctrine) {
    "use strict";

    var WG_MADEUP = 1, WG_STRONG = 101;

    tern.registerPlugin("doc_comment", function (server, options) {
        server.mod.jsdocTypedefs = Object.create(null);
        server.on("reset", function () {
            server.mod.jsdocTypedefs = Object.create(null);
        });
        server.mod.docComment = {
            weight: options && options.strong ? WG_STRONG : undefined,
            fullDocs: options && options.fullDocs
        };

        server.on("postParse", postParse);
        server.on("postInfer", postInfer);
        server.on("postLoadDef", postLoadDef);
    });

    function getJsdocTypedefs(cx) {
        return cx.parent.mod._jsdocTypedefs
    }

    function postParse(ast, text) {
        function attachComments(node) {
            comment.ensureCommentsBefore(text, node);
        }

        walk.simple(ast, {
            VariableDeclaration: attachComments,
            FunctionDeclaration: attachComments,
            MethodDefinition: attachComments,
            Property: attachComments,
            AssignmentExpression: function (node) {
                if (node.operator === "=") attachComments(node);
            },
            CallExpression: function (node) {
                if (isDefinePropertyCall(node)) attachComments(node);
            },
            ExportNamedDeclaration: attachComments,
            ExportDefaultDeclaration: attachComments,
            ClassDeclaration: attachComments
        });
    }

    function isDefinePropertyCall(node) {
        return node.callee.type == "MemberExpression" &&
            node.callee.object.name == "Object" &&
            node.callee.property.name == "defineProperty" &&
            node.arguments.length >= 3 &&
            typeof node.arguments[1].value == "string";
    }

    function postInfer(ast, scope) {
        jsdocParseTypedefs(ast.sourceFile.text, scope);

        walk.simple(ast, {
            VariableDeclaration: function (node, scope) {
                var decl = node.declarations[0].id;
                if (node.commentsBefore && decl.type == "Identifier")
                    interpretComments(node, node.commentsBefore, scope,
                        scope.getProp(node.declarations[0].id.name));
            },
            FunctionDeclaration: function (node, scope) {
                if (node.commentsBefore)
                    interpretComments(node, node.commentsBefore, scope,
                        scope.getProp(node.id.name),
                        node.scope.fnType);
            },
            ClassDeclaration: function (node, scope) {
                if (node.commentsBefore)
                    interpretComments(node, node.commentsBefore, scope,
                        scope.getProp(node.id.name),
                        node.objType);
            },
            AssignmentExpression: function (node, scope) {
                if (node.commentsBefore)
                    interpretComments(node, node.commentsBefore, scope,
                        infer.expressionType({node: node.left, state: scope}));
            },
            ObjectExpression: function (node, scope) {
                for (var i = 0; i < node.properties.length; ++i) {
                    var prop = node.properties[i];
                    if (prop.type == 'SpreadElement') {
                        continue;
                    }
                    var name = infer.propName(prop);
                    if (name != "<i>" && prop.commentsBefore)
                        interpretComments(prop, prop.commentsBefore, scope, node.objType.getProp(name));
                }
            },
            Class: function (node, scope) {
                var proto = node.objType.getProp("prototype").getObjType();
                if (!proto) return;
                for (var i = 0; i < node.body.body.length; i++) {
                    var method = node.body.body[i], name;
                    if (!method.commentsBefore) continue;
                    if (method.kind == "constructor")
                        interpretComments(method, method.commentsBefore, scope, node.objType);
                    else if ((name = infer.propName(method)) != "<i>")
                        interpretComments(method, method.commentsBefore, scope, proto.getProp(name));
                }
            },
            CallExpression: function (node, scope) {
                if (node.commentsBefore && isDefinePropertyCall(node)) {
                    var type = infer.expressionType({node: node.arguments[0], state: scope}).getObjType();
                    if (type && type instanceof infer.Obj) {
                        var prop = type.props[node.arguments[1].value];
                        if (prop) interpretComments(node, node.commentsBefore, scope, prop);
                    }
                }
            },
            ExportNamedDeclaration: function (node, scope) {
                if (node.commentsBefore && node.declaration && node.declaration.type === 'FunctionDeclaration') {
                    interpretComments(node.declaration, node.commentsBefore, scope,
                        scope.getProp(node.declaration.id.name),
                        node.declaration.scope.fnType);
                }
            },
            ExportDefaultDeclaration: function (node, scope) {
                if (node.commentsBefore && node.declaration && node.declaration.type === 'FunctionDeclaration') {
                    interpretComments(node.declaration, node.commentsBefore, scope,
                        scope.getProp(node.declaration.id.name),
                        node.declaration.scope.fnType);
                }
            }
        }, infer.searchVisitor, scope);
    }

    function postLoadDef(data) {
        var defs = data["!typedef"];
        var cx = infer.cx(), orig = data["!name"];
        if (defs) for (var name in defs)
            cx.parent.mod.jsdocTypedefs[name] =
                maybeInstance(infer.def.parse(defs[name], orig, name), name);
    }

    // COMMENT INTERPRETATION

    function stripLeadingChars(lines) {
        for (var head, i = 1; i < lines.length; i++) {
            var line = lines[i], lineHead = line.match(/^[\s\*]*/)[0];
            if (lineHead != line) {
                if (head == null) {
                    head = lineHead;
                } else {
                    var same = 0;
                    while (same < head.length && head.charCodeAt(same) == lineHead.charCodeAt(same)) ++same;
                    if (same < head.length) head = head.slice(0, same);
                }
            }
        }
        lines = lines.map(function (line, i) {
            line = line.replace(/\s+$/, "");
            if (i == 0 && head != null) {
                for (var j = 0; j < head.length; j++) {
                    var found = line.indexOf(head.slice(j));
                    if (found == 0) return line.slice(head.length - j);
                }
            }
            if (head == null || i == 0) return line.replace(/^[\s\*]*/, "");
            if (line.length < head.length) return "";
            return line.slice(head.length);
        });
        while (lines.length && !lines[lines.length - 1]) lines.pop();
        while (lines.length && !lines[0]) lines.shift();
        return lines;
    }

    function interpretComments(node, comments, scope, aval, type) {
        jsdocInterpretComments(node, scope, aval, comments);
        var cx = infer.cx();

        if (!type && aval instanceof infer.AVal && aval.types.length) {
            type = aval.types[aval.types.length - 1];
            if (!(type instanceof infer.Obj) || type.origin != cx.curOrigin || type.doc)
                type = null;
        }

        for (var i = comments.length - 1; i >= 0; i--) {
            var text = stripLeadingChars(comments[i].split(/\r\n?|\n/)).join("\n");
            if (text) {
                if (aval instanceof infer.AVal) aval.doc = text;
                if (type) type.doc = text;
                break;
            }
        }
    }

    // Parses a subset of JSDoc-style comments in order to include the
    // explicitly defined types in the analysis.

    function skipSpace(str, pos) {
        while (/\s/.test(str.charAt(pos))) ++pos;
        return pos;
    }

    function isIdentifier(string) {
        if (!acorn.isIdentifierStart(string.charCodeAt(0))) return false;
        for (var i = 1; i < string.length; i++)
            if (!acorn.isIdentifierChar(string.charCodeAt(i))) return false;
        return true;
    }

    function parseLabelList(scope, str, pos, close) {
        var labels = [], types = [], madeUp = false;
        for (var first = true; ; first = false) {
            pos = skipSpace(str, pos);
            if (first && str.charAt(pos) == close) break;
            var colon = str.indexOf(":", pos);
            if (colon < 0) return null;
            var label = str.slice(pos, colon);
            if (!isIdentifier(label)) return null;
            labels.push(label);
            pos = colon + 1;
            var type = parseType(scope, str, pos);
            if (!type) return null;
            pos = type.end;
            madeUp = madeUp || type.madeUp;
            types.push(type.type);
            pos = skipSpace(str, pos);
            var next = str.charAt(pos);
            ++pos;
            if (next == close) break;
            if (next != ",") return null;
        }
        return {labels: labels, types: types, end: pos, madeUp: madeUp};
    }

    function parseTypeAtom(scope, doc, elemType) {
        var result = parseTypeInner(scope, str, pos);
        if (!result) return null;
        if (str.slice(result.end, result.end + 2) == "[]")
            return {madeUp: result.madeUp, end: result.end + 2, type: new infer.Arr(result.type)};
        else return result;
    }

    function isIdentifier(name) {
        for (var i = 0; i < docType.name.length; i += 1) {
            if (!acorn.isIdentifierChar(docType.name.charCodeAt(i))) return false;
        }

    }

    function parseNameExpression(scope, doc, docType) {
        if (!docType.name) return;
        var type, madeUp = false;
        switch (docType.name.toLowerCase()) {
            case 'bool':
            case 'boolean':
                type = infer.cx().bool;
                break;
            case 'number':
            case 'integer':
                type = infer.cx().num;
                break;
            case 'null':
            case 'undefined':
                type = infer.ANull;
                break;
            case 'string':
                type = infer.cx().str;
                break;
            case 'object':
                type = new infer.Obj(true);
                break;
            case 'array':
                type = new infer.Arr();
                break;
            default: {
                for (var i = 0; i < docType.name.length; i += 1) {
                    if (!acorn.isIdentifierChar(docType.name.charCodeAt(i)) &&
                        docType.name.charAt(i) !== '.' &&
                        docType.name.charAt(i) !== '~') return;
                }
                var path = docType.name;
                var cx = infer.cx(), defs = cx.parent && cx.parent.mod.jsdocTypedefs, found;
                if (defs && (path in defs)) {
                    type = defs[path];
                } else if (found = infer.def.parsePath(path, scope).getObjType()) {
                    type = maybeInstance(found, path);
                } else {
                    // Create as separate module when possible or else use default jsdocPlaceholders:
                    if (!cx.jsdocPlaceholders) cx.jsdocPlaceholders = Object.create(null);
                    if (!(path in cx.jsdocPlaceholders))
                        type = cx.jsdocPlaceholders[path] = new infer.Obj(null, path);
                    else
                        type = cx.jsdocPlaceholders[path];
                    madeUp = true;
                }
            }

        }
        if (!type) return;
        return {type: type, madeUp: madeUp, isOptional: false};

    }

    function interpretType(scope, doc, docType) {
        if (!docType || !docType.type) return;

        var type, inner, madeUp = false, isOptional = false, i;
        var tag = _currTag(doc);

        switch (docType.type) {
            case 'UnionType':
                type = new infer.AVal;
                for (i = 0; i < docType.elements.length; i += 1) {
                    inner = interpretType(scope, doc, docType.elements[i]);
                    if (inner) {
                        inner.type.propagate(type);
                        madeUp = madeUp || inner.madeUp;
                        isOptional = isOptional || inner.isOptional;
                    }
                }
                break;
            case 'OptionalType':
                inner = interpretType(scope, doc, docType.expression);
                if (inner) {
                    type = inner.type;
                    madeUp = madeUp || inner.madeUp;
                }
                isOptional = true;
                break;
            case 'NullableType':
                inner = interpretType(scope, doc, docType.expression);
                if (inner) {
                    type = inner.type;
                    madeUp = madeUp || inner.madeUp;
                }
                isOptional = true;
                break;
            case 'NonNullableType':
                inner = interpretType(scope, doc, docType.expression);
                if (inner) {
                    type = inner.type;
                    madeUp = madeUp || inner.madeUp;
                }
                isOptional = false;
                break;
            case 'RecordType':
                for (i = 0; docType.fields && i < docType.fields.length; i += 1) {
                    var field = docType.fields[i];
                    inner = interpretType(scope, doc, field.value);
                    if (!inner) continue;
                    if (!type) type = new infer.Obj(true);
                    var f = type.defProp(field.key);
                    f.initializer = true;
                    inner.type.propagate(f);
                    madeUp = madeUp || inner.madeUp;
                }
                break;
            case 'ArrayType':
                var arrayTypes = [];
                for (i = 0; docType.elements && i < docType.elements.length; i += 1) {
                    var element = docType.elements[i];
                    inner = interpretType(scope, doc, element);
                    if (!inner) continue;
                    arrayTypes.push(inner.type);
                    madeUp = madeUp || inner.madeUp;
                }
                type = new infer.Arr(arrayTypes);
                break;
            case 'TypeApplication':
                var inAnglesTypes = [];
                for (i = 0; docType.applications && i < docType.applications.length; i += 1) {
                    var application = docType.applications[i];
                    inner = interpretType(scope, doc, application);
                    if (!inner) continue;
                    inAnglesTypes.push(inner.type);
                    madeUp = madeUp || inner.madeUp;
                }
                type = new infer.Arr(inAnglesTypes);
                break;
            case 'NameExpression':
                inner = parseNameExpression(scope, doc, docType);
                if (inner) {
                    type = inner.type;
                    // Added for CodeCab
                    madeUp = madeUp || inner.madeUp;
                    isOptional = isOptional || inner.isOptional;
                }
                break;
            case 'NullLiteral':
                type = infer.ANull;
                break;
            default:
                console.log('Unknown ' + docType.type);
        }
        if (!type) return type;
        return {type: type, madeUp: madeUp, isOptional: isOptional};
    }

    function parseType(scope, doc, pos) {
        var madeUp = false, isOptional = false;
        var defaultValue;

        var tag = _currTag(doc);

        isOptional = tag.default !== undefined;
        if (tag.default) {
            defaultValue = tag.default;
        }

        if (!tag.type) tag.type = {
            type: 'NameExpression',
            name: tag.name,
        };
        tag.type.default = tag.default;
        var inner = interpretType(scope, doc, tag.type);


        if (!inner) return null;
        return {type: inner.type, end: pos, isOptional: inner.isOptional, madeUp: inner.madeUp, defaultValue: defaultValue};
    }


    function maybeInstance(type, path) {
        if (type instanceof infer.Fn && /(?:^|\.)[A-Z][^\.]*$/.test(path)) {
            var proto = type.getProp("prototype").getObjType();
            if (proto instanceof infer.Obj) return infer.getInstance(proto);
        }
        return type;
    }

    function parseTypeOuter(scope, doc, pos) {
        var tag = _currTag(doc);
        if (!tag.type) return null;
        var result = parseType(scope, doc);
        return result;
    }


    function _currTag(doc) {
        return doc.tags[doc.currTag];
    }

    function _nextTag(doc) {
        doc.currTag += 1;
        return _currTag(doc);
    }

    function jsdocInterpretComments(node, scope, aval, comments) {
        var type, args, ret, foundOne, self, parsed;
        for (var i = 0; i < comments.length; i += 1) {
            var comment = comments[i];
            comment = '/** ' + comment + ' */';
            var doc = doctrine.parse(comment, {unwrap: true, sloppy: true, recoverable: true});
            if (!doc) continue;
            if (!doc.tags) continue;

            doc.currTag = 0;
            var tag;
            for (;tag=_currTag(doc);_nextTag(doc)) {
                if (tag.title === 'class' || tag.title === 'constructor') {
                    self = foundOne = true;
                    continue;
                }
                if (tag.title === 'this' &&
                    (parsed = parseType(scope, doc, 0))) {
                    self = parsed;
                    foundOne = true;
                    continue;
                }
                if (!(parsed = parseTypeOuter(scope, doc))) continue;
                foundOne = true;

                switch (tag.title) {
                    case 'returns':
                    case 'return':
                        ret = parsed;
                        break;
                    case 'type':
                        type = parsed;
                        break;
                    case 'param':
                    case 'arg':
                    case 'argument':
                        // Possible jsdoc param name situations:
                        // employee
                        // [employee]
                        // [employee=John Doe]
                        // employee.name
                        // employees[].name
                        var name = tag.name;

                        if (!name) continue;
                        var argname = name;
                        if (parsed.isOptional) argname += "?";

                        // Check to see if the jsdoc is indicating a property of a previously documented parameter
                        var isObjProp = false;
                        var parts = argname.split('.');
                        if (args && parts.length == 2) {
                            var objname = parts[0];
                            argname = parts[1];

                            // Go through each of the previously found parameter to find the
                            // object or array for which this new parameter should be a part
                            // of
                            var key, value;
                            for (key in args) {
                                value = args[key];

                                if (key === objname && value.type instanceof infer.Obj) {
                                    isObjProp = true;
                                    parsed.type.propagate(value.type.defProp(argname));
                                }
                                else if (key + '[]' === objname && value.type instanceof infer.Arr) {
                                    isObjProp = true;
                                    parsed.type.propagate(value.type.getProp("<i>").getType().defProp(argname));
                                }
                            }
                        }
                        if (!isObjProp) {
                            (args || (args = Object.create(null)))[argname] = parsed;
                        }
                        break;
                    default:
                }
            }
        }

        if (foundOne) applyType(type, self, args, ret, node, aval);

    }

    function jsdocParseTypedefs(text, scope) {
        var cx = infer.cx();

        var commentRe = /(\/\*\*[\s\S]*?\*\/)/g, commentResult;
        while ((commentResult = commentRe.exec(text))) {
            var comment = commentResult[1];
            if (comment.indexOf('@typedef') < 0) continue;
            var doc = doctrine.parse(comment, {unwrap: true, sloppy: true, recoverable: true});
            var tag;
            doc.currTag = 0;
            if (!(tag = _currTag(doc))) return;
            var parsed = parseTypeOuter(scope, doc, 0);
            var name = tag.name;
            while (_nextTag(doc)) {
                let currTag = _currTag(doc);
                var propType = parseTypeOuter(scope, doc, 0);
                var propName = _currTag(doc).name;
                if (propType && propName) {
                    let propAval = parsed.type.defProp(propName);
                    // Added for CodeCab
                    if (currTag.description) propAval.doc = currTag.description;
                    if (propType.defaultValue) propAval.default = propType.defaultValue;
                    propType.type.propagate(parsed.type.defProp(propName));
                }
            }
            cx.parent.mod.jsdocTypedefs[name] = parsed.type;
            // TODO
        }

    }

    function propagateWithWeight(type, target) {
        var weight = infer.cx().parent.mod.docComment.weight;
        type.type.propagate(target, weight || (type.madeUp ? WG_MADEUP : undefined));
    }

    function isFunExpr(node) {
        return node.type == "FunctionExpression" || node.type == "ArrowFunctionExpression"
    }

    function applyType(type, self, args, ret, node, aval) {
        var fn;
        if (node.type == "VariableDeclaration") {
            var decl = node.declarations[0];
            if (decl.init && isFunExpr(decl.init)) fn = decl.init.scope.fnType;
        } else if (node.type == "FunctionDeclaration") {
            fn = node.scope.fnType;
        } else if (node.type == "AssignmentExpression") {
            if (isFunExpr(node.right))
                fn = node.right.scope.fnType;
        } else if (node.type == "CallExpression" || node.type === "ClassDeclaration") {
        } else { // An object property
            if (isFunExpr(node.value)) fn = node.value.scope.fnType;
        }

        if (fn && (args || ret || self)) {
            if (args) for (var i = 0; i < fn.argNames.length; ++i) {
                var name = fn.argNames[i], known = args[name];
                if (!known && (known = args[name + "?"]))
                    fn.argNames[i] += "?";
                if (known) propagateWithWeight(known, fn.args[i]);
            }
            if (ret) {
                if (fn.retval == infer.ANull) fn.retval = new infer.AVal;
                propagateWithWeight(ret, fn.retval);
            }
            if (self === true) {
                var proto = fn.getProp("prototype").getObjType();
                self = proto && {type: infer.getInstance(proto, fn)};
            }
            if (self) propagateWithWeight(self, fn.self);
        } else if (type) {
            propagateWithWeight(type, aval);
        }
    }
});
