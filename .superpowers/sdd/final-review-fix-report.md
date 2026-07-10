# Model Config v1.1 Final Review Fix Report

Date: 2026-07-10
Baseline: `cbc672bb9a6c76392709da567f700732e2fe52c2`
Branch: `codex/model-config-v1.1`
Status: DONE

## Scope

This correction addresses only the five final review findings:

1. Provider rename collisions are rejected before native persistence. The command reports an error and leaves both provider records and all private payload identities unchanged.
2. Private payload keys now use the JSON encoding of the exact `[provider, modelId]` tuple. Slash-containing provider and model IDs cannot collide, and provider cleanup decodes the tuple before matching.
3. Successful provider and model copies copy their private payloads after native persistence. Payload copy helpers are not called when the native write fails.
4. Existing blank or whitespace-only `models.json` files throw `ModelsConfigError`; only an absent file produces an empty provider map. Command diagnostics report blank files as unreadable.
5. The package-lock top-level and root-package versions now match `package.json` at `1.1.0`.

The implementation retains JSONC parsing, canonical native saves, preservation of unknown native fields, private-only payload storage, no dynamic provider replay, and no native `extraPayload` field.

## Storage Compatibility

New private payload keys are JSON strings such as `["provider","model/id"]`, stored as object keys in `model-config-payloads.json`. Existing delimiter keys remain readable and migrate during model move/copy/set operations when the provider ID is slash-free, which is the only legacy form that can be resolved safely. A legacy delimiter key that might have originated from a provider ID containing `/` is deliberately not guessed or exposed to that slash-containing provider; automatic disambiguation of such an already-ambiguous key is impossible. All new writes are unambiguous.

Provider copy and rename use one provider-level payload-file update for the named native models. Model copy uses one model-level payload-file update. Native persistence always happens before these private lifecycle updates.

## TDD Evidence

### Red

- `node --experimental-strip-types --test tests/config.test.ts --test-name-pattern="blank or whitespace"`
  - Failed as expected: whitespace-only `models.json` did not throw `ModelsConfigError`.
- `node --experimental-strip-types --test tests/payload-config.test.ts --test-name-pattern="slash-containing|legacy keys|copies model|moves all named"`
  - Failed as expected because the payload copy helpers did not exist and delimiter keys were still in use.
- `node --experimental-strip-types --test tests/index-runtime.test.ts --test-name-pattern="rename collision|provider copy|model copy"`
  - Failed as expected in three command-flow regressions: model copy payload was missing, provider rename overwrote the existing target, and provider copy payloads were missing.

### Green

- `node --experimental-strip-types --test tests/config.test.ts --test-name-pattern="blank or whitespace"`
  - Passed: 6/6 tests in the file, including blank read/write preservation.
- `node --experimental-strip-types --test tests/payload-config.test.ts --test-name-pattern="slash-containing|legacy keys|copies model|moves all named|moves and removes"`
  - Passed: 9/9 tests in the file, including colliding slash identities, cleanup isolation, legacy migration, and copy/move behavior.
- `node --experimental-strip-types --test tests/index-runtime.test.ts --test-name-pattern="rename collision|provider copy|model copy"`
  - Passed: 9/9 tests in the file, including provider/model copy success and failed-native-save sequencing.

## Full Validation

- `npm test`
  - Passed: 69 tests, 0 failed, 0 skipped.
- `npm run check`
  - Passed all configured Node TypeScript syntax checks, including `index.ts` and `payload-config.ts`.
- `git diff --check`
  - Passed with no whitespace errors. Git emitted only repository line-ending conversion notices.
- `rg -n "registerProvider\\(" index.ts`
  - No matches; native providers are not dynamically replayed.
- `rg -n "extraPayload" index.ts types.ts config.ts payload-config.ts`
  - Matches are limited to private `extraPayloads`, request injection, and explicit legacy migration/removal. There is no native `ModelConfig.extraPayload` field.
- `git diff --cached --quiet`
  - Passed before commit; no files were staged during implementation or validation.

## Changed Files

- `README.md`
- `README-CN.md`
- `config.ts`
- `index.ts`
- `package-lock.json`
- `payload-config.ts`
- `tests/config.test.ts`
- `tests/index-runtime.test.ts`
- `tests/payload-config.test.ts`
- `tests/release-docs.test.ts`
- `.superpowers/sdd/final-review-fix-report.md`

## Tests Added or Updated

- Blank and whitespace-only native file read/write protection.
- Command diagnostics for a whitespace-only native file.
- Unambiguous slash-containing provider/model payload identities.
- Provider cleanup isolation across delimiter-equivalent identities.
- Safe legacy delimiter-key lookup and lifecycle migration.
- Model/provider payload copy helpers and provider bulk move behavior.
- Actual `/model-config` provider rename collision flow.
- Actual `/model-config` model and provider copy flows.
- Failed native persistence for both model and provider copy without payload writes.
- Package-lock root version parity and payload-key documentation.

## Residual Risk

- Legacy delimiter keys created for provider IDs that already contained `/` cannot be safely attributed to one identity. They are left inert for slash-containing providers instead of risking cross-model injection or cleanup. New encoded keys have no such ambiguity.
- Native and private files cannot be committed atomically as one filesystem transaction. The required order is enforced: native persistence completes first, then the private payload lifecycle operation runs. A later private-file I/O failure is reported without undoing the successful native save, matching the existing lifecycle contract.

## Repository Hygiene

The pre-existing untracked `.pi-subagents/` directory was not read for implementation, modified, staged, or committed. No pi-subagents repository was touched.
