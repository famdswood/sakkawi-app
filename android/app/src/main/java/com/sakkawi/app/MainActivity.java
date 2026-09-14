package com.sakkawi.app;

import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(StepCounterPlugin.class);
        super.onCreate(savedInstanceState);
        disableWebViewScrollbars();
    }

    @Override
    public void onResume() {
        super.onResume();
        disableWebViewScrollbars();
    }

    private void disableWebViewScrollbars() {
        if (getBridge() != null && getBridge().getWebView() != null) {
            WebView webView = getBridge().getWebView();
            webView.setVerticalScrollBarEnabled(false);
            webView.setHorizontalScrollBarEnabled(false);
            webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        }
    }
}
