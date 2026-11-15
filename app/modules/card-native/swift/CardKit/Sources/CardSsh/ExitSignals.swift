/// A command killed by a signal is reported by the server with the signal's name, never a number (RFC 4254,
/// section 6.10). The app reads exit codes, so the name is turned into what a shell would say, 128 plus the
/// signal's number on Linux, for the signals in this table; any other is a failure, since a code is never made up.
public enum ExitSignals {
  private static let numbers = ["HUP": 1, "INT": 2, "QUIT": 3, "ABRT": 6, "KILL": 9, "SEGV": 11, "PIPE": 13, "ALRM": 14, "TERM": 15]

  /// name: as the server sends it, without "SIG".
  public static func code(_ name: String) -> Int? {
    numbers[name].map { 128 + $0 }
  }
}
