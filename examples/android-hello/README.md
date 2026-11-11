# android-hello

A minimal native Android app (one Java activity with a counter button, no libraries). It exists so `tethertrace build` has something small and real to build, in CI and on your computer.

```bash
tethertrace doctor examples/android-hello
tethertrace build examples/android-hello          # debug APK
tethertrace build examples/android-hello --test   # build, install on your phone, explore
```

CI builds it on Windows, Linux and macOS with `TETHERTRACE_MANAGED_ONLY=1`, which ignores every JDK and Android SDK on the machine. That run downloads the toolchain from nothing, so it proves the path a new user takes.
