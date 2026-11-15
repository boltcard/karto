// Every Gradle daemon started in app/android quits after a minute idle, in both apps. Builds here come hours apart
// (one build when one is asked for), so a daemon kept warm (Gradle's default is three hours) only held memory:
// with its Kotlin daemon and workers ~9 GB, which filled the build machine's swap. A build started
// within the minute, such as the other app's straight after, still finds it warm.
const { withGradleProperties } = require('expo/config-plugins');

const IDLE_TIMEOUT_MS = '60000';

/** gradle.properties' entries with org.gradle.daemon.idletimeout set to a minute, once. */
function setIdleTimeout(properties) {
  const rest = properties.filter((p) => !(p.type === 'property' && p.key === 'org.gradle.daemon.idletimeout'));
  return [...rest, { type: 'property', key: 'org.gradle.daemon.idletimeout', value: IDLE_TIMEOUT_MS }];
}

module.exports = function withGradleDaemon(config) {
  return withGradleProperties(config, (c) => {
    c.modResults = setIdleTimeout(c.modResults);
    return c;
  });
};
module.exports.setIdleTimeout = setIdleTimeout;
