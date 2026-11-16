// A link to no screen of Karto Wallet opens it as its icon does (any app or web page can send a karto:// link).
// The router's own page for this went with its sitemap, which is turned off (app.json): its _sitemap screen could
// be opened by a link and threw on a phone.
import { Redirect } from 'expo-router';

export default function NotFound() {
  return <Redirect href="/" />;
}
