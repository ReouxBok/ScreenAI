# Local braces remediation

This is a local patch of upstream `braces@3.0.3`, not an upstream fixed release.
Source: https://registry.npmjs.org/braces/-/braces-3.0.3.tgz
Published integrity: `sha512-yQbXgO/OSZVD2IsiLlro+7Hf6Q18EJrKSEsdoMzKePKXct3gvD8oLcOQdIzGupr5Fj+EDe8gO/lxc1BzfMpxvA==`.
The upstream MIT license and attribution are preserved in `braces/LICENSE`.

## Security change

The official advisory https://github.com/advisories/GHSA-vfj7-8cjw-p6xm has no
published fixed version at the time of this patch (17 October 2026).
We retain the upstream package name and version so audits remain honest.

- `lib/limits.js` supplies a fixed, caller-independent depth limit of 128.
- `parse` checks the actual stack before adding braces or parentheses. Escaped,
  quoted and bracketed characters retain their existing parsing semantics.
- The recursive `compile`, `expand` and `stringify` walkers also check their
  depth, covering direct AST inputs. Secondary append/flatten recursion and
  expansion parent loops are bounded as well.
- Excess depth raises `SyntaxError` with code `ERR_BRACES_DEPTH` instead of
  exhausting the JavaScript stack. Deep patterns intentionally cease to work.
  The parser limit concerns nested containers; walkers count AST edges,
  including leaf nodes. Normal shallow patterns are unchanged.
- This does not claim a general bound on expansion cardinality, memory use or
  arbitrary accessor-bearing JavaScript objects. Existing range limits remain.

## Installation and integrity

Studio and proxy each contain an identical self-contained tarball under their
own `vendor/` directory. A direct file dependency plus `$braces` override forces
transitive consumers to use it, without install scripts or an external fork.
Each directory can be installed independently with `npm ci`.

`scripts/verify-braces-remediation.mjs` compares all braces lock locations to the
installed inventory, verifies tarball integrity, and hashes every runtime source
file, package metadata and license. Unexpected, missing, symlinked, upstream or
modified copies fail the gate, even if npm reports no vulnerability.
Linked dependency parents and linked node_modules trees are also refused rather
than allowing an uninspected external subtree; npm workspace links would require
separate qualification before being introduced.
Only this exact advisory and these verified copies qualify as locally remediated;
new advisories and audit failures still fail. There is no time-based exception.

## Rebuild

From the repository root:

```sh
node scripts/package-braces-remediation.mjs
npm install --package-lock-only --ignore-scripts --prefix proxy
npm install --package-lock-only --ignore-scripts --prefix studio
```

Review the source diff, archive manifest and both locks. Then install sequentially
and run the tests and audits. CI runs the non-mutating reproducibility check:

```sh
node scripts/package-braces-remediation.mjs --check
```

The archive is reproduced by npm from the reviewed public source. Remove this
local patch only after qualifying an upstream fix or a compatible replacement.
