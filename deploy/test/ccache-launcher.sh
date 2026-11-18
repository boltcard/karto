#!/bin/sh
# CMake's compiler launcher for the Android build's native modules (release-apk.sh sets it): the compile goes
# through ccache, with -Xclang -fno-pch-timestamp added. Reanimated, Worklets and expo-modules-core compile almost
# every file against a precompiled header (target_precompile_headers), and clang records in it the times of the
# headers it was made from: after npm ci every header has a new time, so a precompiled header from the cache would
# be refused, and ccache caches nothing that uses one. Without the times (and with release-apk.sh's
# CCACHE_SLOPPINESS) the header and the files compiled against it are cached like any other.
# Usage (by CMake): ccache-launcher.sh COMPILER ARGS...
exec ccache "$@" -Xclang -fno-pch-timestamp
