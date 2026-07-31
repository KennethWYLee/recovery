# Supply-chain security controls

## Purpose

These local controls make two narrow, reproducible checks available before a release: scan project-owned text for recognizable credential formats, and inventory locked dependencies in a CycloneDX software bill of materials (SBOM). They complement the existing production dependency audit; they do not establish that the application is free of vulnerabilities.

## Commands

Run the complete supply-chain gate:

```text
npm run gate:supply-chain
```

The gate first runs known-good, known-bad, exclusion, and fail-closed tests for the scanner. It then scans the repository and generates `evidence/continuity-ops-sbom.cdx.json` from `package-lock.json`. The SBOM command uses npm's official `npm sbom --package-lock-only --sbom-format cyclonedx --sbom-type application` capability and validates the returned document before replacing the output file. It was locally verified with npm 11.12.1. The dependency inventory is lockfile-based and repeatable, but CycloneDX timestamps and serial identifiers can change between runs; byte-for-byte equality is not claimed.

Individual commands are:

```text
npm run test:security:supply-chain
npm run security:secrets
npm run sbom:generate
npm run audit:production
```

## Secret-scan boundary

The scanner reads UTF-8 text in the project's source, tests, migrations, documentation, configuration, workflow, and scripts. It explicitly excludes dependency and generated-output directories, including `node_modules`, `dist`, `.next`, `.vinext`, and `.wrangler`. Local runtime `.env*` and `.dev.vars*` files are not opened, so their values never enter scanner output; however, the gate fails if Git reports any non-example runtime environment file as tracked. The committed `.env.example` and `.dev.vars.example` templates remain in scan scope. Binary assets are outside the scanner's extension allowlist.

Detection is deliberately limited to private-key headers, recognizable token formats from common providers, and long values assigned to named provider-secret variables. It does not use generic entropy scoring, so ordinary hashes and identifiers do not create noisy findings. Findings report only file, line, and pattern; the candidate value is never printed. An unreadable or invalid UTF-8 file in scope and an unavailable scan root fail the gate rather than silently passing.

## CI status and limitations

The project-local GitHub Actions workflow invokes this gate and retains the generated SBOM with the build artifacts. This workflow is configuration for use when this project is an independent repository; its presence is not evidence that a remote CI run has occurred.

These controls do not scan Git history, remote branches, registry contents, runtime environment files, binary assets, or unknown credential formats. An SBOM is an inventory, not a vulnerability or license conclusion. The controls do not constitute static application security testing, dynamic application security testing, penetration testing, or independent security review. Those activities require separate evidence before they can be claimed.
