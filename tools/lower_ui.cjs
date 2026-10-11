// Hermes v89 reuses captured loop bindings. Lower loops before classes/scopes.
const fs = require("fs");
const path = require("path");
const [babelRoot, input, output] = process.argv.slice(2);
if (!babelRoot || !input || !output)
  throw new Error("Expected babel root, input and output");
const babel = require(path.join(babelRoot, "@babel/core"));
const classes = require(
  path.join(babelRoot, "@babel/plugin-transform-classes"),
);
const blockScoping = require(
  path.join(babelRoot, "@babel/plugin-transform-block-scoping"),
);
const forOf = require(path.join(babelRoot, "@babel/plugin-transform-for-of"));
const source = fs.readFileSync(input, "utf8");
// Separate passes preserve the bindings captured by each loop iteration.
const iteration = babel.transformSync(source, {
  filename: input,
  babelrc: false,
  configFile: false,
  sourceType: "script",
  comments: false,
  compact: false,
  ast: true,
  code: false,
  plugins: [[forOf, { loose: false }]],
});
const result = babel.transformFromAstSync(iteration.ast, source, {
  filename: input,
  babelrc: false,
  configFile: false,
  sourceType: "script",
  comments: false,
  compact: false,
  ast: true,
  plugins: [
    [classes, { loose: false }],
    [
      blockScoping,
      {
        throwIfClosureRequired: false,
        // Babel's TDZ instrumentation resets initialized counters in this pipeline.
        // Keep lexical scopes; source must initialize bindings before reading them.
        tdz: false,
      },
    ],
  ],
});
// Reject syntax that would reintroduce shared captures or broken TDZ counters.
babel.traverse(result.ast, {
  VariableDeclaration(path) {
    if (path.node.kind !== "var")
      throw new Error("Unlowered lexical declaration: " + path.node.kind);
  },
  ForOfStatement() {
    throw new Error("Unlowered for-of statement");
  },
  Identifier(path) {
    if (/^_temporalUndefined\d*$/.test(path.node.name)) {
      throw new Error("Unexpected TDZ sentinel in production output");
    }
  },
});
fs.writeFileSync(output, result.code + "\n");
process.stdout.write(
  JSON.stringify({
    core: require(path.join(babelRoot, "@babel/core/package.json")).version,
    transformClasses: require(
      path.join(babelRoot, "@babel/plugin-transform-classes/package.json"),
    ).version,
    transformBlockScoping: require(
      path.join(
        babelRoot,
        "@babel/plugin-transform-block-scoping/package.json",
      ),
    ).version,
    transformForOf: require(
      path.join(babelRoot, "@babel/plugin-transform-for-of/package.json"),
    ).version,
    loweringPasses: ["for-of", "classes-and-block-scoping"],
    blockScopingOptions: { throwIfClosureRequired: false, tdz: false },
    lexicalReadPolicy: "source-bindings-must-be-initialized-before-read",
  }) + "\n",
);
