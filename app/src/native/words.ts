// What a native module's rejection says, without what Expo puts around it. A person reads these words (an upload
// the server refused, a sheet iOS would not open), and they go to the log. Both shapes were seen on a phone:
// Android's "Call to function '…' has been rejected.\n→ Caused by: <words>", and the iPhone's
// "<Name>Exception: <words> (at <File>.swift:<line>)".
const CAUSED = '→ Caused by: ';
const IOS = /^[A-Za-z]+: ([\s\S]*) \(at [^()\s]+\.swift:\d+\)$/;

export function nativeWords(e: unknown): string {
  let text = e instanceof Error ? e.message : String(e);
  const at = text.lastIndexOf(CAUSED);
  if (at >= 0) text = text.slice(at + CAUSED.length);
  return IOS.exec(text)?.[1] ?? text;
}
