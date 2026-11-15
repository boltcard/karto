// Adds app/deploy-assets (made by `make app-deploy-assets`) to the APK's
// assets, so deploy/bin/cardd and friends can be streamed to the VM, and
// remakes it before every build. The app reads manifest.json from these same
// assets at startup (loadManifest), never from the JS bundle: expo run:android
// bundles the JS before Gradle runs, so a compiled-in manifest went stale.
//
// On iOS the same folder is copied into the app bundle as deploy-assets/ by a
// build step. It only copies: the folder is made on Linux and brought to the
// Mac, so both platforms carry the same bytes (the bundle's hash is what makes
// the app offer "Update server").
const { withAppBuildGradle, withXcodeProject } = require('expo/config-plugins');

const BEGIN = '// withDeployAssets begin';
const END = '// withDeployAssets end';
const BLOCK = `${BEGIN}
android.sourceSets.main.assets.srcDirs += ["../../deploy-assets"]
def cardAppDeployAssets = tasks.register("cardAppDeployAssets", Exec) {
    workingDir rootProject.file("../..")
    commandLine "make", "app-deploy-assets"
}
preBuild.dependsOn(cardAppDeployAssets)
${END}
`;

/** app/build.gradle with exactly one copy of the block (and without the older one-line version). */
function addDeployAssets(gradle) {
  const start = gradle.indexOf(BEGIN);
  const stop = gradle.indexOf(END);
  let out = start >= 0 && stop > start ? gradle.slice(0, start) + gradle.slice(stop + END.length + 1) : gradle;
  out = out.split('\n').filter((l) => !l.endsWith('] // withDeployAssets')).join('\n');
  return out.replace(/\n*$/, '\n\n') + BLOCK;
}

const IOS_PHASE = 'Copy the server bundle (withDeployAssets)';
// cardd is a Linux binary the app only ever uploads: nothing in the bundle keeps its executable bit.
const IOS_SCRIPT = `set -e
src="\${SRCROOT}/../deploy-assets"
if [ ! -f "$src/manifest.json" ]; then
  echo "error: app/deploy-assets/manifest.json is missing: run 'make app-deploy-assets' on Linux and copy app/deploy-assets here" >&2
  exit 1
fi
dst="\${TARGET_BUILD_DIR}/\${UNLOCALIZED_RESOURCES_FOLDER_PATH}/deploy-assets"
rm -rf "\${dst:?}"
mkdir -p "$dst"
cp -R "$src/." "$dst/"
chmod -R a-x,a+X "$dst"
`;

/** The app target with exactly one copy of the build step. `project` is the xcode package's project. */
function addDeployAssetsPhase(project) {
  if (project.pbxItemByComment(IOS_PHASE, 'PBXShellScriptBuildPhase')) return project;
  project.addBuildPhase([], 'PBXShellScriptBuildPhase', IOS_PHASE, project.getFirstTarget().uuid, {
    shellPath: '/bin/sh',
    shellScript: IOS_SCRIPT,
  });
  return project;
}

module.exports = function withDeployAssets(config) {
  const android = withAppBuildGradle(config, (c) => {
    c.modResults.contents = addDeployAssets(c.modResults.contents);
    return c;
  });
  return withXcodeProject(android, (c) => {
    c.modResults = addDeployAssetsPhase(c.modResults);
    return c;
  });
};
module.exports.addDeployAssets = addDeployAssets;
module.exports.addDeployAssetsPhase = addDeployAssetsPhase;
module.exports.IOS_PHASE = IOS_PHASE;
module.exports.IOS_SCRIPT = IOS_SCRIPT;
