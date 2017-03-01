/*
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import 'source-map-support/register';
import * as path from 'path';
import * as ts from 'typescript';

/** VName is the type of Kythe node identities. */
interface VName {
  signature: string;
  path: string;
  language: string;
  root: string;
  corpus: string;
}

/**
 * toArray converts an Iterator to an array of its values.
 * It's necessary when running in ES5 environments where for-of loops
 * don't iterate through Iterators.
 */
function toArray<T>(it: Iterator<T>): T[] {
  let array: T[] = [];
  for (let next = it.next(); !next.done; next = it.next()) {
    array.push(next.value);
  }
  return array;
}

/**
 * TSNamespace represents the two namespaces of TypeScript: types and values.
 * A given symbol may be a type, it may be a value, and the two may even
 * be unrelated.
 *
 * See the table at
 *   https://www.typescriptlang.org/docs/handbook/declaration-merging.html
 *
 * TODO: there are actually three namespaces; the third is (confusingly)
 * itself called namespaces.  Implement those in this enum and other places.
 */
enum TSNamespace {
  TYPE,
  VALUE,
}

/** Visitor manages the indexing process for a single TypeScript SourceFile. */
class Vistor {
  /** sourceFile is the ts.SourceFile we're currently indexing. */
  sourceFile: ts.SourceFile;

  /** kFile is the VName for the source file. */
  kFile: VName;

  /**
   * symbolNames maps ts.Symbols to their assigned VNames.
   * The value is a tuple of the separate TypeScript namespaces, and entries
   * in it correspond to TSNamespace values.  See the documentation of
   * TSNamespace.
   */
  symbolNames = new Map<ts.Symbol, [VName | null, VName|null]>();

  /**
   * anonId increments for each anonymous block, to give them unique
   * signatures.
   */
  anonId = 0;

  constructor(
      private typeChecker: ts.TypeChecker,
      /**
       * Absolute path to the corpus root.  Note that sourceFile.sourcePath is
       * the absolute path to the source file, but for output purposes we want a
       * repository-relative path.
       */
      private sourceRoot: string) {}

  /**
   * emit emits a Kythe entry, structured as a JSON object.  Defaults to
   * emitting to stdout but users may replace it.
   */
  emit =
      (obj: any) => {
        // TODO: allow control of where the output is produced.
        console.log(JSON.stringify(obj));
      }

  /** newVName returns a new VName pointing at the current file. */
  newVName(signature: string, sourceFile = this.sourceFile): VName {
    return {
      signature,
      path: path.relative(this.sourceRoot, sourceFile.path),
      language: 'typescript',
      root: '',
      corpus: 'TODO',
    };
  }

  /** newAnchor emits a new anchor entry that covers a TypeScript node. */
  newAnchor(node: ts.Node): VName {
    let name = this.newVName(`@${node.pos}:${node.end}`);
    this.emitNode(name, 'anchor');
    // TODO: loc/* should be in bytes, but these offsets are in UTF-16 units.
    this.emitFact(name, 'loc/start', node.getStart().toString());
    this.emitFact(name, 'loc/end', node.getEnd().toString());
    this.emitEdge(name, 'childof', this.kFile);
    return name;
  }

  /** emitNode emits a new node entry, declaring the kind of a VName. */
  emitNode(source: VName, kind: string) {
    this.emitFact(source, 'node/kind', kind);
  }

  /** emitFact emits a new fact entry, tying an attribute to a VName. */
  emitFact(source: VName, name: string, value: string) {
    this.emit({
      source,
      fact_name: '/kythe/' + name,
      fact_value: new Buffer(value).toString('base64'),
    });
  }

  /** emitEdge emits a new edge entry, relating two VNames. */
  emitEdge(source: VName, name: string, target: VName) {
    this.emit({
      source,
      edge_kind: '/kythe/edge/' + name, target,
      fact_name: '/',
    });
  }

  /**
   * scopedSignature computes a scoped name for a ts.Node.
   * E.g. if you have a function `foo` containing a block containing a variable
   * `bar`, it might return a string like foo.block0.bar.
   * Also returns the source file containing the node.
   */
  scopedSignature(startNode: ts.Node): [string, ts.SourceFile] {
    let sourceFile: ts.SourceFile|undefined;
    let parts: string[] = [];

    // Traverse the containing blocks upward, gathering names from nodes that
    // introduce scopes.
    for (let node: ts.Node|undefined = startNode; node != null;
         node = node.parent) {
      switch (node.kind) {
        case ts.SyntaxKind.Block:
          if (node.parent &&
              (node.parent.kind === ts.SyntaxKind.FunctionDeclaration ||
               node.parent.kind === ts.SyntaxKind.MethodDeclaration)) {
            // A block that's an immediate child of a function is the
            // function's body, so it doesn't need a separate name.
            continue;
          }
          parts.push(`block${this.anonId++}`);
          break;
        case ts.SyntaxKind.ClassDeclaration:
        case ts.SyntaxKind.FunctionDeclaration:
        case ts.SyntaxKind.InterfaceDeclaration:
        case ts.SyntaxKind.MethodDeclaration:
        case ts.SyntaxKind.Parameter:
        case ts.SyntaxKind.PropertyDeclaration:
        case ts.SyntaxKind.PropertySignature:
        case ts.SyntaxKind.VariableDeclaration:
          let decl = node as ts.Declaration;
          if (decl.name && decl.name.kind === ts.SyntaxKind.Identifier) {
            parts.push(decl.name.text);
          } else {
            // TODO: handle other declarations, e.g. binding patterns.
            parts.push(`anon${this.anonId++}`);
          }
          break;
        case ts.SyntaxKind.SourceFile:
          sourceFile = node as ts.SourceFile;
          break;
        default:
          // Most nodes are children of other nodes that do not introduce a
          // new namespace, e.g. "return x;", so ignore all other parents
          // by default.
          // TODO: namespace {}, etc.
      }
    }

    // The names were gathered from bottom to top, so reverse before joining.
    return [parts.reverse().join('.'), sourceFile!];
  }

  /** getSymbolName computes the VName (and signature) of a ts.Symbol. */
  getSymbolName(sym: ts.Symbol, ns: TSNamespace): VName {
    let vnames = this.symbolNames.get(sym);
    if (vnames && vnames[ns]) return vnames[ns]!;

    if (!sym.declarations || sym.declarations.length < 1) {
      throw new Error('TODO: symbol has no declarations?');
    }
    // TODO: think about symbols with multiple declarations.

    let decl = sym.declarations[0];
    let [sig, sourceFile] = this.scopedSignature(decl);
    // The signature of a value is undecorated;
    // the signature of a type has the #type suffix.
    if (ns === TSNamespace.TYPE) {
      sig += '#type';
    }

    // Compute a vname and save it in the appropriate slot in the symbolNames
    // table.
    let vname = this.newVName(sig, sourceFile);
    if (!vnames) vnames = [null, null];
    vnames[ns] = vname;
    this.symbolNames.set(sym, vnames);

    return vname;
  }

  visitInterfaceDeclaration(decl: ts.InterfaceDeclaration) {
    let sym = this.typeChecker.getSymbolAtLocation(decl.name);
    let kType = this.getSymbolName(sym, TSNamespace.TYPE);
    this.emitNode(kType, 'interface');
    this.emitEdge(this.newAnchor(decl.name), 'defines/binding', kType);

    for (const member of decl.members) {
      this.visit(member);
    }
  }

  visitTypeAliasDeclaration(decl: ts.TypeAliasDeclaration) {
    let sym = this.typeChecker.getSymbolAtLocation(decl.name);
    let kType = this.getSymbolName(sym, TSNamespace.TYPE);
    this.emitNode(kType, 'alias');
    this.emitEdge(this.newAnchor(decl.name), 'defines/binding', kType);

    this.visitType(decl.type);
  }

  /**
   * visitType is the main dispatch for visiting type nodes.
   * It's separate from visit() because bare ts.Identifiers within a normal
   * expression are values (handled by visit) but bare ts.Identifiers within
   * a type are types (handled here).
   */
  visitType(node: ts.Node): void {
    switch (node.kind) {
      case ts.SyntaxKind.Identifier:
        let sym = this.typeChecker.getSymbolAtLocation(node);
        let name = this.getSymbolName(sym, TSNamespace.TYPE);
        this.emitEdge(this.newAnchor(node), 'ref', name);
        return;
      default:
        // Default recursion, but using visitType(), not visit().
        return ts.forEachChild(node, n => this.visitType(n));
    }
  }

  visitExportDeclaration(decl: ts.ExportDeclaration) {
    // TODO: this code doesn't do much yet, but it's enough to silence a TODO
    // that is printed in unrelated tests.
    if (decl.exportClause) {
      for (const element of decl.exportClause.elements) {
        console.warn(`TODO: handle export element in ${decl.getText()}`);
      }
    }
    if (decl.moduleSpecifier) {
      console.warn(`TODO: handle module specifier in ${decl.getText()}`);
    }
  }

  /**
   * Note: visitVariableDeclaration is also used for class properties;
   * the decl parameter is the union of the attributes of the two types.
   */
  visitVariableDeclaration(decl: {
    name: ts.BindingName | ts.PropertyName,
    type?: ts.TypeNode,
    initializer?: ts.Expression,
  }) {
    if (decl.name.kind === ts.SyntaxKind.Identifier) {
      let sym = this.typeChecker.getSymbolAtLocation(decl.name);
      let kVar = this.getSymbolName(sym, TSNamespace.VALUE);
      this.emitNode(kVar, 'variable');

      this.emitEdge(this.newAnchor(decl.name), 'defines/binding', kVar);
    } else {
      console.warn(
          'TODO: handle variable declaration:', ts.SyntaxKind[decl.name.kind]);
    }
    if (decl.type) this.visitType(decl.type);
    if (decl.initializer) this.visit(decl.initializer);
  }

  visitFunctionLikeDeclaration(decl: ts.FunctionLikeDeclaration) {
    let kFunc: VName;
    if (decl.name) {
      let sym = this.typeChecker.getSymbolAtLocation(decl.name);
      kFunc = this.getSymbolName(sym, TSNamespace.VALUE);
      this.emitNode(kFunc, 'function');

      this.emitEdge(this.newAnchor(decl.name), 'defines/binding', kFunc);
    } else {
      // TODO: choose VName for anonymous functions.
      kFunc = this.newVName('TODO');
    }

    for (const [index, param] of toArray(decl.parameters.entries())) {
      let sym = this.typeChecker.getSymbolAtLocation(param.name);
      let kParam = this.getSymbolName(sym, TSNamespace.VALUE);
      this.emitNode(kParam, 'variable');
      this.emitEdge(kFunc, `param.${index}`, kParam);

      this.emitEdge(this.newAnchor(param.name), 'defines/binding', kParam);
    }

    if (decl.body) this.visit(decl.body);
  }

  visitClassDeclaration(decl: ts.ClassDeclaration) {
    if (decl.name) {
      let sym = this.typeChecker.getSymbolAtLocation(decl.name);
      let kClass = this.getSymbolName(sym, TSNamespace.VALUE);
      this.emitNode(kClass, 'record');

      this.emitEdge(this.newAnchor(decl.name), 'defines/binding', kClass);
    }
    for (const member of decl.members) {
      this.visit(member);
    }
  }

  /** visit is the main dispatch for visiting AST nodes. */
  visit(node: ts.Node): void {
    switch (node.kind) {
      case ts.SyntaxKind.ExportDeclaration:
        return this.visitExportDeclaration(node as ts.ExportDeclaration);
      case ts.SyntaxKind.VariableDeclaration:
        return this.visitVariableDeclaration(node as ts.VariableDeclaration);
      case ts.SyntaxKind.PropertyDeclaration:
        return this.visitVariableDeclaration(node as ts.PropertyDeclaration);
      case ts.SyntaxKind.FunctionDeclaration:
      case ts.SyntaxKind.MethodDeclaration:
        return this.visitFunctionLikeDeclaration(
            node as ts.FunctionLikeDeclaration);
      case ts.SyntaxKind.ClassDeclaration:
        return this.visitClassDeclaration(node as ts.ClassDeclaration);
      case ts.SyntaxKind.InterfaceDeclaration:
        return this.visitInterfaceDeclaration(node as ts.InterfaceDeclaration);
      case ts.SyntaxKind.TypeAliasDeclaration:
        return this.visitTypeAliasDeclaration(node as ts.TypeAliasDeclaration);
      case ts.SyntaxKind.TypeReference:
        return this.visitType(node as ts.TypeNode);
      case ts.SyntaxKind.Identifier:
        // Assume that this identifer is occurring as part of an
        // expression; we handle identifiers that occur in other
        // circumstances (e.g. in a type) separately in visitType.
        let sym = this.typeChecker.getSymbolAtLocation(node);
        if (!sym) {
          // E.g. a field of an "any".
          return;
        }
        if (!sym.declarations || sym.declarations.length === 0) {
          // An undeclared symbol, e.g. "undefined".
          return;
        }
        let name = this.getSymbolName(sym, TSNamespace.VALUE);
        this.emitEdge(this.newAnchor(node), 'ref', name);
        return;
      default:
        // Use default recursive processing.
        return ts.forEachChild(node, n => this.visit(n));
    }
  }

  /** indexFile is the main entry point, starting the recursive visit. */
  indexFile(file: ts.SourceFile) {
    this.sourceFile = file;
    this.kFile = this.newVName(/* empty signature */ '');
    this.kFile.language = '';
    this.emitFact(this.kFile, 'node/kind', 'file');
    this.emitFact(this.kFile, 'text', file.text);
    ts.forEachChild(file, n => this.visit(n));
  }
}

/**
 * index indexes a TypeScript program, producing Kythe JSON objects for the
 * source files in the specified paths.
 *
 * (A ts.Program is a configured collection of parsed source files, but
 * the caller must specify the source files within the program that they want
 * Kythe output for, because e.g. the standard library is contained within
 * the Program and we only want to process it once.)
 *
 * @param emit If provided, a function that receives objects as they
 */
export function index(
    paths: string[], program: ts.Program, emit?: (obj: any) => void) {
  let diags = ts.getPreEmitDiagnostics(program);
  if (diags.length > 0) {
    let message = ts.formatDiagnostics(diags, {
      getCurrentDirectory() {
        return process.cwd();
      },
      getCanonicalFileName(fileName: string) {
        return fileName;
      },
      getNewLine() {
        return '\n';
      },
    });
    throw new Error(message);
  }

  for (const path of paths) {
    let sourceFile = program.getSourceFile(path);
    let visitor = new Vistor(program.getTypeChecker(), process.cwd());
    if (emit != null) {
      visitor.emit = emit;
    }
    visitor.indexFile(sourceFile);
  }
}

function main(argv: string[]) {
  if (argv.length < 3) {
    console.error('usage: indexer PATH...');
    return 1;
  }
  let inPaths = argv.slice(2);
  // TODO: accept compiler options from the user.
  // These options are just enough to get indexer.ts itself indexable.
  let tsOpts: ts.CompilerOptions = {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2015,
    // NOTE: the 'lib' parameter in tsconfig.json is translated by the 'tsc'
    // command-line parser into one of these values, which are what the compiler
    // uses internally.  This is just enough to get this indexer.ts to be able
    // to load itself for debugging.
    lib: ['lib.es6.d.ts'],
  };
  let program = ts.createProgram(inPaths, tsOpts);
  index(inPaths, program);
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}