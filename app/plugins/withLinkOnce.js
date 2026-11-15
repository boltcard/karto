// Karto PoS's links act: a pairing link pairs the phone. Android keeps the link that first opened an app as its
// task's own, and hands it over again whenever it remakes the activity (from Recents, or from the icon after it
// killed the app); and React Native reads "the link the app was opened with" from the activity, which a link
// arriving while the app is still starting doesn't change. So in MainActivity: a remade activity's link is cleared
// before React reads it, and the newest link is made the activity's own. Karto PoS's build alone (variant.js);
// the app also remembers the links it has answered (src/pos/settings.ts), whatever Android does.
const { withMainActivity } = require('expo/config-plugins');

const MARK = '// withLinkOnce';
const CREATE = '    super.onCreate(null)\n  }\n';
const CLEAR = `    ${MARK}: a link opens the app once. Remade by Android, the activity starts without the link that first opened it.
    if (savedInstanceState != null || (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) {
      intent = Intent(intent).setData(null)
    }
`;
const NEW_INTENT = `
  ${MARK}: a link that arrives while the app is starting is the one it starts with.
  override fun onNewIntent(intent: Intent) {
    setIntent(intent)
    super.onNewIntent(intent)
  }
`;

/** MainActivity.kt with the two changes, once. Throws on a MainActivity it can't place them in: the build must not go on without them. */
function linkOnce(kotlin) {
  if (kotlin.includes(MARK)) return kotlin;
  const places = [CREATE, 'import android.os.Bundle\n'];
  for (const place of places) {
    if (kotlin.split(place).length !== 2) throw new Error(`withLinkOnce: MainActivity.kt has changed: expected exactly one "${place.trim()}"`);
  }
  return kotlin
    .replace('import android.os.Bundle\n', 'import android.content.Intent\nimport android.os.Bundle\n')
    .replace(CREATE, CLEAR + CREATE + NEW_INTENT);
}

module.exports = function withLinkOnce(config) {
  return withMainActivity(config, (c) => {
    if (c.modResults.language !== 'kt') throw new Error('withLinkOnce: MainActivity is not Kotlin');
    c.modResults.contents = linkOnce(c.modResults.contents);
    return c;
  });
};
module.exports.linkOnce = linkOnce;
