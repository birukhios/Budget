package et.birukfin.forwarder

import android.net.Uri
import com.google.androidbrowserhelper.trusted.LauncherActivity

/**
 * Opens the PWA full-screen in Chrome's Trusted Web Activity — no URL bar,
 * no browser chrome, the user's own Chrome engine and cookies.
 *
 * The URL is read from preferences rather than baked into the manifest, so
 * one APK works against whatever server you point it at.
 */
class TwaLauncher : LauncherActivity() {

    override fun getLaunchingUrl(): Uri {
        val base = Forwarder.config(this)?.first
        return if (base.isNullOrBlank()) Uri.parse("about:blank") else Uri.parse(base)
    }

    /** Splash is handled by the theme; skip the helper's own delay. */
    override fun shouldLaunchImmediately() = true
}
