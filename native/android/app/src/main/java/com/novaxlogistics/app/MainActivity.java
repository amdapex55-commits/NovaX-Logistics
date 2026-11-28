package com.novaxlogistics.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugins must be registered before the bridge starts.
        registerPlugin(NovaxPrintPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
