# Changelog

All notable changes to claude-agent-tui will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This project is a fork of [`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp) v0.53.0 (see [`.fork-provenance.json`](.fork-provenance.json)).

## [0.14.9](https://github.com/zeo-workspace/claude-agent-tui/compare/v0.14.8...v0.14.9) (2026-10-04)


### Documentation

* fit the npm description within the registry's 255 characters ([ba9c8ec](https://github.com/zeo-workspace/claude-agent-tui/commit/ba9c8ec7c5a0bc8911e8c28f99658152d91d2cf9))

## [0.14.8](https://github.com/zeo-workspace/claude-agent-tui/compare/v0.14.7...v0.14.8) (2026-10-04)


### Documentation

* state the project's status, and install through the published binary ([10cf464](https://github.com/zeo-workspace/claude-agent-tui/commit/10cf464514b7a220eddae3a93d2de6dde7e76967))

## [0.14.7](https://github.com/zeo-workspace/claude-agent-tui/compare/v0.14.6...v0.14.7) (2026-10-04)


### Fixed

* **replay:** stop replaying a background task's notification as a prompt ([e276a3f](https://github.com/zeo-workspace/claude-agent-tui/commit/e276a3fd479ddb3f9000b0d9420a067ca60f51d1))

## [0.14.6](https://github.com/zeo-workspace/claude-agent-tui/compare/v0.14.5...v0.14.6) (2026-10-03)


### Fixed

* **deps:** @modelcontextprotocol/sdk 1.31.0 -&gt; 1.32.0, clearing GHSA-22jm-h49p-29qw and GHSA-6prh-2h8m-c8cw ([570ed57](https://github.com/zeo-workspace/claude-agent-tui/commit/570ed576bb9ddd552f567cda17088dd211e99ef6))

## [0.14.5](https://github.com/zeo-workspace/claude-agent-tui/compare/v0.14.4...v0.14.5) (2026-10-03)


### Fixed

* **deps:** @modelcontextprotocol/sdk 1.30.0 -&gt; 1.31.0, clearing GHSA-6qxp-vccf-f47h ([ab6f252](https://github.com/zeo-workspace/claude-agent-tui/commit/ab6f252670099910ca65e29c20891863395a2baf))


### Infrastructure

* point repository URLs at the zeo-workspace organization ([f68cd1e](https://github.com/zeo-workspace/claude-agent-tui/commit/f68cd1e95325c16c0796a7b71dd15e35b7ec6517))
* run the gitleaks CLI instead of gitleaks-action ([7e092b3](https://github.com/zeo-workspace/claude-agent-tui/commit/7e092b3e30d14e307132e0dd4f54e663f1f81025))

## [0.14.4](https://github.com/lucascouts/claude-agent-tui/compare/v0.14.3...v0.14.4) (2026-09-30)


### Fixed

* **deps:** @agentclientprotocol/sdk 1.4.0 -&gt; 1.5.1, and hono with it ([4476f83](https://github.com/lucascouts/claude-agent-tui/commit/4476f833c3a2c159132f4edc14aca80488358563))

## [0.14.3](https://github.com/lucascouts/claude-agent-tui/compare/v0.14.2...v0.14.3) (2026-09-26)


### Fixed

* **permissions:** honor permissions.disableBypassPermissionsMode ([071278d](https://github.com/lucascouts/claude-agent-tui/commit/071278d15d5e1f125c3751a75e89b61a29d1e7f5))

## [0.14.2](https://github.com/lucascouts/claude-agent-tui/compare/v0.14.1...v0.14.2) (2026-09-26)


### Infrastructure

* **deps:** bump the minor group with 8 updates ([#107](https://github.com/lucascouts/claude-agent-tui/issues/107)) ([9a4f7e6](https://github.com/lucascouts/claude-agent-tui/commit/9a4f7e6e9000903efd2b2b0124e846247f8d7238))

## [0.14.1](https://github.com/lucascouts/claude-agent-tui/compare/v0.14.0...v0.14.1) (2026-09-26)


### Fixed

* **replay:** replay marker-only slash skill prompts ([d5fefc0](https://github.com/lucascouts/claude-agent-tui/commit/d5fefc0c6ba9409a8df677ae8ee02a775eb90464))
* **startup:** keep the agent starting when the managed-policy tier cannot be read ([05a13b2](https://github.com/lucascouts/claude-agent-tui/commit/05a13b2dcd17d1221b39e9d643884c2bce09611d))
* **tools:** render Write calls that use the path/file_text aliases ([bffe5a2](https://github.com/lucascouts/claude-agent-tui/commit/bffe5a239ac1785b239dc86fd90195da10d2d731))


### Infrastructure

* **deps:** bump fast-uri from 3.1.7 to 3.1.8 ([#108](https://github.com/lucascouts/claude-agent-tui/issues/108)) ([b70da7c](https://github.com/lucascouts/claude-agent-tui/commit/b70da7c80b2fad264df1e6fd003c782a97ae3ab8))
* **deps:** bump github/codeql-action/upload-sarif ([#106](https://github.com/lucascouts/claude-agent-tui/issues/106)) ([23a29f3](https://github.com/lucascouts/claude-agent-tui/commit/23a29f353d414273bbc3fa5d3f1d075f2f2a04bf))
* **deps:** bump google/osv-scanner-action/osv-scanner-action ([#104](https://github.com/lucascouts/claude-agent-tui/issues/104)) ([a47b4a1](https://github.com/lucascouts/claude-agent-tui/commit/a47b4a1dfb576a0f07bd86bfd1360bf40f75d4e8))
* **deps:** bump trufflesecurity/trufflehog from 3.97.4 to 3.97.5 ([#105](https://github.com/lucascouts/claude-agent-tui/issues/105)) ([fa3175d](https://github.com/lucascouts/claude-agent-tui/commit/fa3175d0c736f3a6b4a21fdb24cc332e6d11b5b2))

## [0.14.0](https://github.com/lucascouts/claude-agent-tui/compare/v0.13.3...v0.14.0) (2026-09-23)


### Added

* **models:** read the picker from the CLI instead of curating it by hand ([711e684](https://github.com/lucascouts/claude-agent-tui/commit/711e684d60f854f93c8fbc11ec34e0b77af3f76a))


### Fixed

* **lint:** drop the MODEL_CATALOG import the live catalogue made unused ([82fa02a](https://github.com/lucascouts/claude-agent-tui/commit/82fa02afb6b85f5ed12f69ac3eecc77d8011f1f9))
* **models:** report the catalogue fallback on `log`, once per process ([df2add8](https://github.com/lucascouts/claude-agent-tui/commit/df2add82e768a0a88d4c6874cf2e38fbd09a48f7))


### Infrastructure

* **gitignore:** ignore .epic/, once ([7a8be1f](https://github.com/lucascouts/claude-agent-tui/commit/7a8be1fb9ad0e22ae7e7636a5b164235d1679402))

## [0.13.3](https://github.com/lucascouts/claude-agent-tui/compare/v0.13.2...v0.13.3) (2026-09-19)


### Infrastructure

* **deps:** bump github/codeql-action/upload-sarif ([#100](https://github.com/lucascouts/claude-agent-tui/issues/100)) ([11998ed](https://github.com/lucascouts/claude-agent-tui/commit/11998eda26fd9213fd3dcca3c9da5a53c97ff1c5))
* **deps:** bump the minor group with 14 updates ([#101](https://github.com/lucascouts/claude-agent-tui/issues/101)) ([8bd857f](https://github.com/lucascouts/claude-agent-tui/commit/8bd857ff58563399ea693d747e1567b0697a487b))

## [0.13.2](https://github.com/lucascouts/claude-agent-tui/compare/v0.13.1...v0.13.2) (2026-09-11)


### Infrastructure

* **trufflehog:** pin the scanner, not just the wrapper ([#98](https://github.com/lucascouts/claude-agent-tui/issues/98)) ([2e94022](https://github.com/lucascouts/claude-agent-tui/commit/2e94022dc0a2f4ec8c681bd99191636a35721ce5))

## [0.13.1](https://github.com/lucascouts/claude-agent-tui/compare/v0.13.0...v0.13.1) (2026-09-11)


### Infrastructure

* **deps:** bump trufflesecurity/trufflehog from 3.97.1 to 3.97.4 ([#95](https://github.com/lucascouts/claude-agent-tui/issues/95)) ([58b7e24](https://github.com/lucascouts/claude-agent-tui/commit/58b7e2472de6f4574fd4cac111b0cfdd3cd5b407))

## [0.13.0](https://github.com/lucascouts/claude-agent-tui/compare/v0.12.2...v0.13.0) (2026-09-05)


### Added

* **catalog:** add Fable 5.1, and port the two reachable v0.71.0 fragments ([be3bd81](https://github.com/lucascouts/claude-agent-tui/commit/be3bd8150d0ed5bb033826765ca598abb00d1675))

## [0.12.2](https://github.com/lucascouts/claude-agent-tui/compare/v0.12.1...v0.12.2) (2026-09-05)


### Infrastructure

* **deps:** reach the same pins as the ACP fork, and pay 1.4.0's two removals ([1d5c124](https://github.com/lucascouts/claude-agent-tui/commit/1d5c124f69694829dd918ad8fbc4ad82f0f15b56))

## [0.12.1](https://github.com/lucascouts/claude-agent-tui/compare/v0.12.0...v0.12.1) (2026-09-05)


### Documentation

* sanitise the one path that hid behind a slash ([#92](https://github.com/lucascouts/claude-agent-tui/issues/92)) ([86536c4](https://github.com/lucascouts/claude-agent-tui/commit/86536c49f03a5ea3b42e67adf35c5d275a6edfae))


### Infrastructure

* **deps:** bump anchore/sbom-action from 0.24.0 to 0.24.2 ([#86](https://github.com/lucascouts/claude-agent-tui/issues/86)) ([58c8f61](https://github.com/lucascouts/claude-agent-tui/commit/58c8f615d1f1bc4245b70576b5d733affb7528a8))
* **deps:** bump fast-uri from 3.1.5 to 3.1.7 ([#82](https://github.com/lucascouts/claude-agent-tui/issues/82)) ([66ac29d](https://github.com/lucascouts/claude-agent-tui/commit/66ac29de71efa5a34b92270f5487e60eeb3302af))
* **deps:** bump github/codeql-action/upload-sarif ([#85](https://github.com/lucascouts/claude-agent-tui/issues/85)) ([5fb041a](https://github.com/lucascouts/claude-agent-tui/commit/5fb041ae313e341c9175291fcf115bea1f842ec0))
* **deps:** bump qs from 6.15.3 to 6.16.0 ([#83](https://github.com/lucascouts/claude-agent-tui/issues/83)) ([02a7eee](https://github.com/lucascouts/claude-agent-tui/commit/02a7eeeb48718e1a457077b26f6ea7a0e834c083))
* **deps:** bump the minor group across 1 directory with 19 updates ([#90](https://github.com/lucascouts/claude-agent-tui/issues/90)) ([4f1d93f](https://github.com/lucascouts/claude-agent-tui/commit/4f1d93f47c8c3714ac7e063c8c1e105d2a67f7d6))
* **deps:** bump trufflesecurity/trufflehog from 3.97.0 to 3.97.1 ([#84](https://github.com/lucascouts/claude-agent-tui/issues/84)) ([90c16c2](https://github.com/lucascouts/claude-agent-tui/commit/90c16c2b87eb129654843f04ca955381c2ffaacc))
* raise the Build timeout to 15 minutes, where a cache miss fits ([#89](https://github.com/lucascouts/claude-agent-tui/issues/89)) ([888881a](https://github.com/lucascouts/claude-agent-tui/commit/888881ab139578ffd3d4ed4d4d6b5730f81859d9))

## [0.12.0](https://github.com/lucascouts/claude-agent-tui/compare/v0.11.1...v0.12.0) (2026-09-02)


### Added

* **parity:** land the SDK alignment and the four upstream ports ([#80](https://github.com/lucascouts/claude-agent-tui/issues/80)) ([620e00b](https://github.com/lucascouts/claude-agent-tui/commit/620e00ba778c8e8ca737520175fb4a615e702c81))


### Infrastructure

* **deps:** bump eventsource-parser from 3.1.0 to 3.1.1 ([#77](https://github.com/lucascouts/claude-agent-tui/issues/77)) ([2a385f1](https://github.com/lucascouts/claude-agent-tui/commit/2a385f13cf07143e186612aad039649d807bc783))
* **deps:** Bump github/codeql-action/upload-sarif ([#74](https://github.com/lucascouts/claude-agent-tui/issues/74)) ([7dd21a4](https://github.com/lucascouts/claude-agent-tui/commit/7dd21a432dc92091d40237eb6e3ba8d12ae2d9da))
* **deps:** Bump google/osv-scanner-action/osv-scanner-action ([#75](https://github.com/lucascouts/claude-agent-tui/issues/75)) ([06a430a](https://github.com/lucascouts/claude-agent-tui/commit/06a430a58f6edf4c63076302f02211475b71ae14))
* **deps:** bump the minor group with 5 updates, and drop the case it removes ([#76](https://github.com/lucascouts/claude-agent-tui/issues/76)) ([4f86e30](https://github.com/lucascouts/claude-agent-tui/commit/4f86e304f09126a5ba9b940c6672c84ff561ceef))
* ignore .epic here too, where the guard was missing ([#79](https://github.com/lucascouts/claude-agent-tui/issues/79)) ([5d8e78b](https://github.com/lucascouts/claude-agent-tui/commit/5d8e78bb07a6df547d3cb9cbf3d2c6e170dca095))

## [0.11.1](https://github.com/lucascouts/claude-agent-tui/compare/v0.11.0...v0.11.1) (2026-08-26)


### Fixed

* **084:** replace the TaskList line regex with a linear scanner (CodeQL 16, 17) ([f959eb2](https://github.com/lucascouts/claude-agent-tui/commit/f959eb2469323b2526f1e615314e61044464d617))

## [0.11.0](https://github.com/lucascouts/claude-agent-tui/compare/v0.10.3...v0.11.0) (2026-08-26)


### Added

* **083:** port Skill tool calls and repair the Task* plan ([#986](https://github.com/lucascouts/claude-agent-tui/issues/986), [#974](https://github.com/lucascouts/claude-agent-tui/issues/974)) ([a46fadb](https://github.com/lucascouts/claude-agent-tui/commit/a46fadb58c86afbaabecd9340382ec293c6ed4b2))


### Infrastructure

* **083:** take claude-agent-sdk 0.3.232, re-converging with upstream ([3c0bc47](https://github.com/lucascouts/claude-agent-tui/commit/3c0bc4703427e289792082d7c8654eed17e04006))

## [0.10.3](https://github.com/lucascouts/claude-agent-tui/compare/v0.10.2...v0.10.3) (2026-08-24)


### Infrastructure

* bring @anthropic-ai/claude-agent-sdk up to 0.3.226 ([#71](https://github.com/lucascouts/claude-agent-tui/issues/71)) ([a439bd1](https://github.com/lucascouts/claude-agent-tui/commit/a439bd17c7cdb040e6239df8efd0a3511c74ec3d))
* **deps:** Bump github/codeql-action/upload-sarif ([#65](https://github.com/lucascouts/claude-agent-tui/issues/65)) ([8c910c0](https://github.com/lucascouts/claude-agent-tui/commit/8c910c05603f11958e6ebb7076b3dec27d7cd90d))
* **deps:** Bump google/osv-scanner-action/osv-scanner-action ([#61](https://github.com/lucascouts/claude-agent-tui/issues/61)) ([f5e0a25](https://github.com/lucascouts/claude-agent-tui/commit/f5e0a251a5927521e7a9e991eabcedf8215a79b7))
* **deps:** Bump the minor group across 1 directory with 19 updates ([#66](https://github.com/lucascouts/claude-agent-tui/issues/66)) ([bd0455c](https://github.com/lucascouts/claude-agent-tui/commit/bd0455c0850a0741a14647c9e59b3e5bc2f4d6ec))
* **deps:** Bump trufflesecurity/trufflehog from 3.96.0 to 3.97.0 ([#64](https://github.com/lucascouts/claude-agent-tui/issues/64)) ([bf6854d](https://github.com/lucascouts/claude-agent-tui/commit/bf6854dc579349aca874c7d627f39983a9466ea9))

## [0.10.2](https://github.com/lucascouts/claude-agent-tui/compare/v0.10.1...v0.10.2) (2026-08-23)


### Fixed

* report the live model on a resumed session ([8ad9cea](https://github.com/lucascouts/claude-agent-tui/commit/8ad9ceac33ac791711032c3bdd4c376f530706f8))

## [0.10.1](https://github.com/lucascouts/claude-agent-tui/compare/v0.10.0...v0.10.1) (2026-08-09)


### Infrastructure

* drop Scorecard's push trigger, it races the CI it measures ([aede516](https://github.com/lucascouts/claude-agent-tui/commit/aede5164a1c30f4fe9ba0826fbf5947ec7c988ba))

## [0.10.0](https://github.com/lucascouts/claude-agent-tui/compare/v0.9.0...v0.10.0) (2026-08-09)


### ⚠ BREAKING CHANGES

* engines.node moves from >=20 to >=24. Installs on Node 20, 22 and 23 are no longer supported.

### Added

* add a --version flag reporting package, fork point and claude versions ([ab2dfe4](https://github.com/lucascouts/claude-agent-tui/commit/ab2dfe4c6eb98f13594aabd58d80f08a7f7abce5))
* require Node &gt;=24 (active LTS) ([a2fcbcc](https://github.com/lucascouts/claude-agent-tui/commit/a2fcbcca6553ecc9d5039ede21e003fcd3bd3778))


### Infrastructure

* **deps-dev:** bump @types/node to 26.1.2 and acorn to 8.18.0 ([d5b25fb](https://github.com/lucascouts/claude-agent-tui/commit/d5b25fb3d69d7f89e3a1a7fca0a7db73683c0d86))
* **deps:** Bump github/codeql-action/upload-sarif ([96480c4](https://github.com/lucascouts/claude-agent-tui/commit/96480c4dfc4ba6589fe1fb97fe2a2370214c3140))
* **deps:** Bump github/codeql-action/upload-sarif from 4.37.3 to 4.37.4 ([9ccb06b](https://github.com/lucascouts/claude-agent-tui/commit/9ccb06b1caf11a69cc99a068cff7e6fdcbb2fd09))
* let release-please actually read release-please-config.json ([17752f7](https://github.com/lucascouts/claude-agent-tui/commit/17752f74081e5f79fde3ea021df32763b6949d8e))
* pin release-please tags to v&lt;version&gt;, not &lt;component&gt;-v&lt;version&gt; ([6d7b30e](https://github.com/lucascouts/claude-agent-tui/commit/6d7b30ecee16499d54244699988735670ccbbd29))

## [0.9.0](https://github.com/lucascouts/claude-agent-tui/compare/v0.8.0...v0.9.0) (2026-08-06)


### Features

* render tool results from the transcript's structured toolUseResult ([39c8296](https://github.com/lucascouts/claude-agent-tui/commit/39c8296266f672bf16e32e8ecf60bef4103efd8b))

## [0.8.0](https://github.com/lucascouts/claude-agent-tui/compare/v0.7.0...v0.8.0) (2026-07-11)


### Features

* **073:** fast mode toggle (Opus-only, live /fast inject, detect-before) ([23b296d](https://github.com/lucascouts/claude-agent-tui/commit/23b296daf29a9120515a47e51bbcf08383740d4b))
* **073:** live /fast signal classifier + opt-in probe (Task 1 spike, Task 3.1) ([7de04c6](https://github.com/lucascouts/claude-agent-tui/commit/7de04c61175ee5e1a502c710b4b132d4a181dfdf))
* **fork:** add Fable 5 to model selector; drop redundant sonnet[1m] + opusplan ([049e197](https://github.com/lucascouts/claude-agent-tui/commit/049e1977deb9b958060b4b50bd019fc637da9ac6))


### Bug Fixes

* eqeqeq-clean null check in clientSupportsBooleanConfigOptions ([0c213e4](https://github.com/lucascouts/claude-agent-tui/commit/0c213e4a7b29257c8d1448c0266862f096af3d0d))

## [0.7.0](https://github.com/lucascouts/claude-agent-tui/compare/v0.6.0...v0.7.0) (2026-07-02)


### Features

* **062:** implement ACP logout method ([1acfd68](https://github.com/lucascouts/claude-agent-tui/commit/1acfd68099be011b17c0e29dbf2310b22b269a57))
* **063:** offline available_commands discovery (commands + skills + plugins + built-ins) ([afce715](https://github.com/lucascouts/claude-agent-tui/commit/afce715e7b509fb5c219e5da9e73a151206fce59))
* **064:** deny AskUserQuestion at the gate (anti-stall bridge guard) ([0428714](https://github.com/lucascouts/claude-agent-tui/commit/0428714de45adef578d8f29d932b9732b1c805a2))
* **065:** relay AskUserQuestion via ACP elicitation (form), fail-closed degrade to 064 ([d1dfe6a](https://github.com/lucascouts/claude-agent-tui/commit/d1dfe6ab6a5fdbdbab242c823863cd9ee0414176))
* **072:** show model version/context in Zed selector descriptions ([496e976](https://github.com/lucascouts/claude-agent-tui/commit/496e97686665b0b28ee72f858a7cd6fa2e7b5fb6))


### Bug Fixes

* **061:** wire session/delete to the SDK-expected handler name ([f26c7a4](https://github.com/lucascouts/claude-agent-tui/commit/f26c7a4e9bceade682b6521f0081c8965a1ce355))
* **068:** report correct context-window size per model (200K vs 1M) ([31a1548](https://github.com/lucascouts/claude-agent-tui/commit/31a15486fc38b349820f4bdb4a20331577daa7ab))
* **069:** authoritative context window from the transcript + original /model descriptions ([bd46d0a](https://github.com/lucascouts/claude-agent-tui/commit/bd46d0ae46517f80cf61d44c8036dba1f34bf866))
* **070:** re-vendor baseline v0.39.0 → v0.53.0 (provenance + claude-agent-sdk 0.3.195) ([6f36e38](https://github.com/lucascouts/claude-agent-tui/commit/6f36e38f4fdfb540aefbe01dc19bf8c627f7da68))
* **071:** Sonnet 5 native 1M context window (version-aware sonnet resolver) ([77813b9](https://github.com/lucascouts/claude-agent-tui/commit/77813b9bbbe3a815cd3e7120d4b1aae756a96fa9))

## [0.6.0](https://github.com/lucascouts/claude-agent-tui/compare/v0.5.2...v0.6.0) (2026-06-29)


### Features

* **panel:** hybrid agent discovery — probe claude for canonical list + glob fallback ([29948ce](https://github.com/lucascouts/claude-agent-tui/commit/29948ce2fabad101eec0ea1bc84b8fe979be52a2))
* **panel:** live /effort + pre-interaction fresh re-spawn for agent/mode + optimistic mode feedback ([fa0b6b5](https://github.com/lucascouts/claude-agent-tui/commit/fa0b6b56a029c23b5865d3162955b586af07f042))
* **panel:** surface auto permission mode + realign model catalog to the original ([93e0d11](https://github.com/lucascouts/claude-agent-tui/commit/93e0d11beececd1a3e95a3f93db78f82f3b0a882))
* **panel:** ultracode effort-selector entry — sentinel + Option A apply (story 060) ([1c36be7](https://github.com/lucascouts/claude-agent-tui/commit/1c36be7835ccad82bc604007ec412b5d92686caa))
* **panel:** v0.52 parity — effort selector, agent picker, render fixes, title push ([b4e99d6](https://github.com/lucascouts/claude-agent-tui/commit/b4e99d6bea7486a52ff59cee23a19e9358a558b8))


### Bug Fixes

* **059:** claude-path tests→dist + SettingsManager fs.watch unref; devDeps v0.52 bump ([da5fd09](https://github.com/lucascouts/claude-agent-tui/commit/da5fd09df8ca6f4f446b3a772895e21860099da3))
* **effort:** map ultracode sentinel to xhigh at the mode/agent re-spawn seam (R1.2) ([39c215d](https://github.com/lucascouts/claude-agent-tui/commit/39c215d332ec0f0acbfb3eb8648e24080ac18ed4))
* **image:** satisfy eqeqeq in vision smoke + bind temp-image sink before promptToClaude ([266a777](https://github.com/lucascouts/claude-agent-tui/commit/266a777a7447a03ec4495b69b0275fe91e60905c))

## [0.5.2](https://github.com/lucascouts/claude-agent-tui/compare/v0.5.1...v0.5.2) (2026-06-27)


### Bug Fixes

* **gate:** live correlation + subagent attribution (story 055 sync) ([aa97908](https://github.com/lucascouts/claude-agent-tui/commit/aa979084e213be38f059fc1da74afafc001c1b53))

## [0.5.1](https://github.com/lucascouts/claude-agent-tui/compare/v0.5.0...v0.5.1) (2026-06-25)


### Bug Fixes

* **ci:** Cosign sign-blob --bundle (v4 deprecated --output-signature/-certificate) ([5c57a3f](https://github.com/lucascouts/claude-agent-tui/commit/5c57a3f573a16efab1b9b9ae824f9298e507ed06))

## [0.5.0](https://github.com/lucascouts/claude-agent-tui/compare/v0.4.0...v0.5.0) (2026-06-25)


### Features

* **049:** claude binary drift resilience — mirror sync ([c91b833](https://github.com/lucascouts/claude-agent-tui/commit/c91b8333d1cf3ed466a816d81af5befe4dfc5ff8))
* **054:** subagent permission relay (mirror) + PERMISSIONS.md ([9c8b308](https://github.com/lucascouts/claude-agent-tui/commit/9c8b30855974e200e3575d8ac0ebd8c58d993eef))

## [0.4.0](https://github.com/lucascouts/claude-agent-tui/compare/v0.3.1...v0.4.0) (2026-06-23)


### Features

* **deps:** update dependency chain + clear advisories (mirror fork story 047) ([99be617](https://github.com/lucascouts/claude-agent-tui/commit/99be61736fd49a920fd1f6bf98633ec5e214e3a0))


### Bug Fixes

* linear-time local-command marker stripping (CodeQL js/polynomial-redos) (mirror fork story 052) ([b75e9c9](https://github.com/lucascouts/claude-agent-tui/commit/b75e9c98bc8ec320e27340ade397e6c9e1936277))

## [0.3.1](https://github.com/lucascouts/claude-agent-tui/compare/v0.3.0...v0.3.1) (2026-06-19)


### Documentation

* note June 15 pause of the SDK billing split (README + npm description) ([a427339](https://github.com/lucascouts/claude-agent-tui/commit/a4273392379962431599140df3b47ec1127a8677))

## [0.3.0](https://github.com/lucascouts/claude-agent-tui/compare/v0.2.2...v0.3.0) (2026-06-19)


### Features

* live Agent Panel selectors (model/effort/permission-mode) + model-switch hang fix ([b1c56d4](https://github.com/lucascouts/claude-agent-tui/commit/b1c56d4804ece8574feee4fca1e6c20784b7fe48))


### Bug Fixes

* **046:** defer discovery + guard for in-place re-spawn (live boot-bypass stall) ([cd6ac2e](https://github.com/lucascouts/claude-agent-tui/commit/cd6ac2e4768ae2b878b824e67e4cf5fd184dcca9))
* **046:** permission mode drives the TUI + gate honors mode (Bug A) ([4826257](https://github.com/lucascouts/claude-agent-tui/commit/482625775ec35e239a6d40c64925e57f3d5a0139))
* **deps:** treat BetaFallbackBlock as no-op (@anthropic-ai/sdk 0.104) ([bdfff4b](https://github.com/lucascouts/claude-agent-tui/commit/bdfff4b613c157bcaf191a2cd808eb23bf23af53))

## [0.2.2](https://github.com/lucascouts/claude-agent-tui/compare/v0.2.1...v0.2.2) (2026-06-13)


### Miscellaneous Chores

* release 0.2.2 ([d93c027](https://github.com/lucascouts/claude-agent-tui/commit/d93c027182354acfaa770fca82b5cbf566b2f282))

## [0.2.1](https://github.com/lucascouts/claude-agent-tui/compare/v0.2.0...v0.2.1) (2026-06-12)


### Miscellaneous Chores

* release 0.2.1 ([1783f85](https://github.com/lucascouts/claude-agent-tui/commit/1783f85f4a1512b4b9480e1689f65fe024d10126))

## [0.2.0](https://github.com/lucascouts/claude-agent-tui/compare/v0.1.1...v0.2.0) (2026-06-12)


### Features

* migrate @agentclientprotocol/sdk to 0.25.0 (SessionModel → configOption "model") ([8d7b87d](https://github.com/lucascouts/claude-agent-tui/commit/8d7b87d23d7cf0288dd9e0f5548069d809b7cc09))
  * `0.25.0` removed the `SessionModel` protocol surface. Model selection now flows through the generic `configOptions` mechanism (`category: "model"`), built from `modelInfos` — the advertised selector content is unchanged.
  * Removed the dead legacy surface: the `SessionModelState` / `SetSessionModel*` types, the `unstable_setSessionModel` method, and the `models` field on `NewSessionResponse`. Internal model-matching logic (`resolveModelPreference`, `inferContextWindowFromModel`, …) is preserved unchanged.
  * Updated the `session-update-union` pin to `0.25.0`; the `SessionUpdate` union additively gained `plan_update` and `plan_removed`.
  * Dropped the `@agentclientprotocol/sdk` hold from Dependabot now that the migration has landed.

## [0.1.1](https://github.com/lucascouts/claude-agent-tui/compare/v0.1.0...v0.1.1) (2026-06-12)


### Bug Fixes

* **lint:** clear 10 eslint errors in src (no-undef, cause, default-case, const) ([617a2f5](https://github.com/lucascouts/claude-agent-tui/commit/617a2f5cfef722ba9e056b640f307bb00227883e))

## [0.1.0] - 2026-06-12

### Added

- ACP agent that drives the **Claude Code subscription TUI over a PTY**, rendering Claude Code threads in Zed and other ACP-compatible clients.
- Rendering of text, thinking, tool calls, structured diffs, TODO plans, and nested sub-agents.
- Token-usage updates, prompt input, cancellation, and session load/replay.
- `NOTICE` file with upstream attribution (Apache-2.0 derivative work).

### Changed

- **Engine rewrite**: spawns the `claude` subscription CLI in a pseudo-terminal and translates its JSONL transcript into ACP `session/update` notifications, instead of calling the Claude Agent SDK.
- `agentInfo.title` is reported as **"Claude Agent TUI"**.

### Removed

- Upstream vitest suite; the regression suite now runs under `node --test` (`npm test`).

[0.1.0]: https://github.com/lucascouts/claude-agent-tui/releases/tag/v0.1.0
