# shellcheck shell=sh
# Sourced by the scripts that build the app: the Android SDK where Android
# Studio puts it, and a JDK to run Gradle on (some modules compile Java with
# the toolchain Gradle runs on, and a JRE alone has no compiler). Gradle's own
# downloaded JDK is used when there is no javac on the PATH.
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
if [ -z "${JAVA_HOME:-}" ] && ! command -v javac >/dev/null 2>&1; then
	for jdk in "$HOME"/.gradle/jdks/*-21-*; do
		if [ -x "$jdk/bin/javac" ]; then
			JAVA_HOME=$jdk
			export JAVA_HOME
			break
		fi
	done
fi
