package com.restaurantpos.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DirectPrintPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
