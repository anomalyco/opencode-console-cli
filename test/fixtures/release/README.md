The release service's protocol test vectors, copied byte for byte from the service's own test suite: `decisions.json`
(the client rules `ReleaseService.decide` follows), `manifests.json` and `semver.json`. When the protocol changes, the
service's maintainers recopy all three; `release-vectors.test.ts` fails until the client matches them.
