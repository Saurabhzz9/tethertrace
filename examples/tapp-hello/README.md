# tapp-hello

A small web app with no framework, used to try the experimental `.tapp` package format.

```bash
tethertrace pack examples/tapp-hello -o hello.tapp
tethertrace tapp verify hello.tapp
tethertrace run hello.tapp --platform desktop    # preview in a browser
tethertrace run hello.tapp --platform android    # on your phone, inside the tapp runtime
tethertrace convert hello.tapp --to apk          # a standalone Android app
```

It shows the four things a runtime has to get right: the app's own storage, WebAssembly, a network request that is refused because the manifest does not ask for the network, and a permission that was not requested.

See [docs/universal-runtime](../../docs/universal-runtime/README.md).
