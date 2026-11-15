// Which build this is: the Play build, made with
// KARTO_STORE=play, carries UnifiedPush's embedded FCM distributor and gets its alerts through Google's push unless
// a distributor such as ntfy is installed; every other build is Google-free. deploy/test/release-apk.sh puts the
// setting into the bundle as EXPO_PUBLIC_KARTO_STORE.
export const isPlayBuild = process.env.EXPO_PUBLIC_KARTO_STORE === 'play';
