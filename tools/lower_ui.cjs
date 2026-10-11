// This Hermes v89 compiler needs classes and lexical loop captures lowered.
// In particular, its direct `for (let key of ...)` output reused one captured
// environment for every esbuild export getter. Babel creates a fresh function
// invocation per iteration before Hermes sees that loop.
const fs = require('fs');
const path = require('path');
const [babelRoot, input, output] = process.argv.slice(2);
if (!babelRoot || !input || !output) throw new Error('Expected babel root, input and output');
const babel = require(path.join(babelRoot, '@babel/core'));
const classes = require(path.join(babelRoot, '@babel/plugin-transform-classes'));
const blockScoping = require(path.join(babelRoot, '@babel/plugin-transform-block-scoping'));
const forOf = require(path.join(babelRoot, '@babel/plugin-transform-for-of'));
const source = fs.readFileSync(input, 'utf8');
// Lower iteration first, in a separate pass. Keeping lexical declarations in
// this pass lets the second pass identify and wrap bindings captured by
// closures in the generated loop body.
const iteration = babel.transformSync(source, {
  filename: input, babelrc: false, configFile: false, sourceType: 'script',
  comments: false, compact: false, ast: true, code: false,
  plugins: [[forOf, {loose: false}]],
});
const result = babel.transformFromAstSync(iteration.ast, source, {
  filename: input, babelrc: false, configFile: false, sourceType: 'script',
  comments: false, compact: false, ast: true,
  plugins: [[classes, {loose: false}], [blockScoping, {
    throwIfClosureRequired: false,
    // Babel 7.29.7's TDZ instrumentation can reset an initialized for-loop
    // counter to _temporalUndefined inside its body (observed in method() and
    // MD5). The audited UI does not intentionally read lexical bindings before
    // initialization. Omit TDZ emulation while retaining lexical scope/renaming,
    // const-write errors, and fresh environments for captured loop bindings.
    tdz: false,
  }]],
});
// Fail the production build if a transform leaves lexical declarations behind;
// allowing those through can silently merge otherwise distinct loop captures.
babel.traverse(result.ast, {
  VariableDeclaration(path) {
    if (path.node.kind !== 'var') throw new Error('Unlowered lexical declaration: ' + path.node.kind);
  },
  ForOfStatement() {
    throw new Error('Unlowered for-of statement');
  },
  Identifier(path) {
    if (/^_temporalUndefined\d*$/.test(path.node.name)) {
      throw new Error('Unexpected TDZ sentinel in production output');
    }
  },
});
fs.writeFileSync(output, result.code + '\n');
process.stdout.write(JSON.stringify({
  core: require(path.join(babelRoot, '@babel/core/package.json')).version,
  transformClasses: require(path.join(babelRoot, '@babel/plugin-transform-classes/package.json')).version,
  transformBlockScoping: require(path.join(babelRoot, '@babel/plugin-transform-block-scoping/package.json')).version,
  transformForOf: require(path.join(babelRoot, '@babel/plugin-transform-for-of/package.json')).version,
  loweringPasses: ['for-of', 'classes-and-block-scoping'],
  blockScopingOptions: {throwIfClosureRequired: false, tdz: false},
  lexicalReadPolicy: 'source-bindings-must-be-initialized-before-read',
}) + '\n');
