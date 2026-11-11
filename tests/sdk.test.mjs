import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installSdkPackage, parseSdkPackage, prepareSdk, resolveAndroidToolchain, ToolchainError } from "../dist/index.js";
import { zip } from "./helpers/apk.mjs";

const tmp = (p) => mkdtemp(join(tmpdir(), p));
const exists = (p) => stat(p).then(() => true, () => false);

// The shape of Google's repository2-3.xml (shortened license text, real element layout).
const PLATFORM_ZIP = zip([
  { name: "android-36/android.jar", data: Buffer.from("jar bytes"), deflate: true },
  { name: "android-36/source.properties", data: Buffer.from("Pkg.Desc=Android SDK Platform 36\n") },
  { name: "android-36/data/res/values/x.xml", data: Buffer.from("<r/>"), deflate: true },
]);
const sha1 = (b) => createHash("sha1").update(b).digest("hex");
const platform = (path, api, url, extra = "", checksum = sha1(PLATFORM_ZIP)) => `
  <remotePackage path="${path}">
    <type-details xsi:type="sdk:platformDetailsType">
      <api-level>${api}</api-level>
      <extension-level>17</extension-level>
      <base-extension>true</base-extension>
      <layoutlib api="15"/>
    </type-details>
    <revision>
      <major>2</major>
    </revision>
    <display-name>Android SDK Platform ${api}</display-name>
    <uses-license ref="android-sdk-license"/>
    <channelRef ref="channel-0"/>${extra}
    <archives>
      <archive>
        <complete>
          <size>${PLATFORM_ZIP.length}</size>
          <checksum type="sha1">${checksum}</checksum>
          <url>${url}</url>
        </complete>
      </archive>
    </archives>
  </remotePackage>`;
const hostArchive = (os) => `<archive><complete><size>10</size><checksum type="sha1">${"a".repeat(40)}</checksum><url>build-tools_r36_${os}.zip</url></complete><host-os>${os}</host-os></archive>`;
const INDEX = `<?xml version='1.0' encoding='utf-8'?>
<sdk:sdk-repository xmlns:sdk="http://schemas.android.com/sdk/android/repo/repository2/03" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <license id="android-sdk-license" type="text">Terms and Conditions

This is the Android Software Development Kit License Agreement</license>
  <license id="android-sdk-preview-license" type="text">Preview terms</license>
  ${platform("platforms;android-36.1", "36.1", "platform-36.1_r01.zip")}
  ${platform("platforms;android-36", "36", "platform-36_r02.zip")}
  ${platform("platforms;android-37", "37", "platform-37_r01.zip").replace("channel-0", "channel-1")}
  ${platform("platforms;android-33", "33", "platform-33_r03.zip", "", "0".repeat(40))}
  <remotePackage path="build-tools;36.0.0">
    <type-details xsi:type="generic:genericDetailsType"/>
    <revision><major>36</major><minor>0</minor><micro>0</micro></revision>
    <display-name>Android SDK Build-Tools 36</display-name>
    <uses-license ref="android-sdk-license"/>
    <channelRef ref="channel-0"/>
    <archives>${hostArchive("linux")}${hostArchive("macosx")}${hostArchive("windows")}</archives>
  </remotePackage>
</sdk:sdk-repository>`;

/** Serves the index and the platform archive the way dl.google.com does. */
function fakeGoogle() {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(String(url));
    if (String(url).endsWith("/repository2-3.xml")) return new Response(INDEX);
    if (/platform-3[36]_r0\d\.zip$/.test(String(url))) return new Response(PLATFORM_ZIP, { headers: { "content-length": String(PLATFORM_ZIP.length) } });
    return new Response("", { status: 404 });
  };
  return { asked, fetchImpl };
}

test("SDK index: finds exactly the named stable package, its checksum, and writes the package description", () => {
  const p = parseSdkPackage(INDEX, "platforms;android-36", "linux");
  assert.equal(p.url, "platform-36_r02.zip"); // not android-36.1
  assert.equal(p.sha1, sha1(PLATFORM_ZIP));
  assert.equal(p.size, PLATFORM_ZIP.length);
  // The same form the SDK manager writes, so the Android Gradle Plugin recognises the platform.
  assert.match(p.packageXml, /^<\?xml version="1.0" encoding="UTF-8" standalone="yes"\?><ns2:repository xmlns:ns2="http:\/\/schemas.android.com\/repository\/android\/common\/02"/);
  assert.match(p.packageXml, /<license id="android-sdk-license" type="text">Terms and Conditions/);
  assert.match(p.packageXml, /<localPackage path="platforms;android-36" obsolete="false"><type-details xmlns:xsi="http:\/\/www.w3.org\/2001\/XMLSchema-instance" xsi:type="ns11:platformDetailsType"><api-level>36<\/api-level><extension-level>17<\/extension-level><base-extension>true<\/base-extension><layoutlib api="15"\/><\/type-details><revision><major>2<\/major><\/revision><display-name>Android SDK Platform 36<\/display-name><uses-license ref="android-sdk-license"\/><\/localPackage><\/ns2:repository>$/);
  assert.doesNotMatch(p.packageXml, /archives|channelRef|Preview terms/);

  assert.equal(parseSdkPackage(INDEX, "platforms;android-37", "linux"), undefined, "a beta-channel package is not installed");
  assert.equal(parseSdkPackage(INDEX, "platforms;android-99", "linux"), undefined);
  assert.equal(parseSdkPackage(INDEX, "build-tools;36.0.0", "windows").url, "build-tools_r36_windows.zip");
  assert.match(parseSdkPackage(INDEX, "build-tools;36.0.0", "macosx").packageXml, /xsi:type="ns5:genericDetailsType"><\/type-details><revision><major>36<\/major><minor>0<\/minor><micro>0<\/micro><\/revision>/);
  assert.equal(parseSdkPackage(INDEX, "build-tools;36.0.0", "plan9"), undefined);
});

test("installSdkPackage: asks first, checks the SHA-1, unpacks into place, leaves nothing half-done", async () => {
  process.env.TETHERTRACE_HOME = await tmp("tt-home-");
  const root = join(await tmp("tt-sdk-"), "sdk");
  const g = fakeGoogle();

  await assert.rejects(installSdkPackage(root, "platforms;android-36", { fetchImpl: g.fetchImpl, consent: async () => false }), (e) => e instanceof ToolchainError && e.code === "CONSENT");
  assert.ok(!g.asked.some((u) => u.endsWith(".zip")), "nothing is downloaded before approval");

  const consents = [];
  await installSdkPackage(root, "platforms;android-36", { fetchImpl: g.fetchImpl, consent: async (q) => (consents.push(q), true) });
  assert.match(consents[0].what, /platforms;android-36/);
  assert.match(consents[0].detail, /dl\.google\.com/);
  assert.equal(await readFile(join(root, "platforms", "android-36", "android.jar"), "utf8"), "jar bytes");
  assert.ok(await exists(join(root, "platforms", "android-36", "data", "res", "values", "x.xml")));
  assert.match(await readFile(join(root, "platforms", "android-36", "package.xml"), "utf8"), /<localPackage path="platforms;android-36"/);
  assert.ok(g.asked.includes("https://dl.google.com/android/repository/platform-36_r02.zip"));

  // The index names a different checksum for this one: refuse, and leave no folder behind.
  await assert.rejects(installSdkPackage(root, "platforms;android-33", { fetchImpl: g.fetchImpl, consent: async () => true }), (e) => e.code === "CHECKSUM");
  assert.ok(!(await exists(join(root, "platforms", "android-33"))));

  await assert.rejects(installSdkPackage(root, "platforms;android-99", { fetchImpl: g.fetchImpl, consent: async () => true }), /no stable package/);
  await assert.rejects(installSdkPackage(root, "../../outside", { fetchImpl: g.fetchImpl, consent: async () => true }), /Not an SDK package path/);
});

test("an SDK from nothing: licenses recorded only after approval, then the one platform, with no SDK manager and no JDK", async () => {
  process.env.TETHERTRACE_HOME = await tmp("tt-home-");
  const home = process.env.TETHERTRACE_HOME;
  const g = fakeGoogle();
  const license = join(home, "toolchains", "android-sdk", "licenses", "android-sdk-license");

  await assert.rejects(prepareSdk(undefined, undefined, 36, { fetchImpl: g.fetchImpl, consent: async () => false }), /licenses were not accepted/);
  assert.ok(!(await exists(license)), "declining leaves no license file");

  const asked = [];
  const sdk = await prepareSdk(undefined, undefined, 36, { fetchImpl: g.fetchImpl, consent: async (q) => (asked.push(q.what), true) });
  assert.deepEqual(asked, ["Android SDK licenses", "Android SDK package platforms;android-36"]);
  assert.equal(sdk.root, join(home, "toolchains", "android-sdk"));
  assert.equal(sdk.source, "tethertrace (managed)");
  assert.equal(sdk.licensesAccepted, true);
  assert.deepEqual(sdk.platforms, [36]);
  assert.equal(sdk.hasCmdlineTools, false);
  assert.match(await readFile(license, "utf8"), /24333f8a63b6825ea9c5514f83c2829b004d1fee/);

  // Asking again changes nothing and downloads nothing.
  const before = g.asked.length;
  assert.deepEqual((await prepareSdk(sdk, undefined, 36, { fetchImpl: g.fetchImpl, consent: async () => assert.fail("nothing to approve") })).platforms, [36]);
  assert.equal(g.asked.length, before);

  // The whole resolve step finds it as a complete SDK for a project compiling against 36.
  const project = { gradleRoot: await tmp("tt-proj-"), requiredJdk: 17, modules: [{ path: ":app", compileSdk: 36 }] };
  const t = await resolveAndroidToolchain(project, { env: { TETHERTRACE_MANAGED_ONLY: "1" } });
  assert.deepEqual(t.missing.map((m) => m.what).filter((w) => w !== "jdk"), []);
});
