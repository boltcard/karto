// A link to no screen of Karto PoS opens it as its icon does (any app or web page can send a kartopos:// link).
import { Redirect } from 'expo-router';

export default function NotFound() {
  return <Redirect href="/" />;
}
