package com.adguard.trusttunnel

interface AppNotifier {
    fun onStateChanged(state: Int);
    fun onConnectionInfo(info: String);
}