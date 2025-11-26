package com.adguard.testapp

import FlutterCallbacks
import android.app.Activity
import android.content.Context
import com.adguard.trusttunnel.AppNotifier

class AppNotifierImpl (
    private val callbacks: FlutterCallbacks,
    private val activity: Activity
) : AppNotifier {
    override fun onStateChanged(state: Int) {
        activity.runOnUiThread {
            callbacks.onStateChanged(state.toLong()) {}
        }
    }

    override fun onConnectionInfo(info: String) {
        activity.runOnUiThread {
            callbacks.onConnectionInfo(info) {}
        }
    }
}