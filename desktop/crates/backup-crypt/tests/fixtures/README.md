# Public age compatibility fixture

`scrypt` is copied byte-for-byte from `age` 0.12.1,
`tests/testdata/testkit/scrypt` (MIT OR Apache-2.0 package), which vendors the
[age testkit](https://github.com/C2SP/CCTV/tree/main/age).
The upstream testkit offers [0BSD OR CC0-1.0 OR Unlicense](https://github.com/C2SP/CCTV/blob/main/age/README.md#license).
This copy is used under CC0-1.0.
Its metadata contains a public synthetic password (`password`) and the expected
SHA-256 of the plaintext. This is test data, not a user credential.

The adapter decrypts this external vector and checks that digest. Reverse tests
read adapter-produced files directly with age's reader. No age/rage CLI execution
or real cloud/provider acceptance is implied by these tests.
