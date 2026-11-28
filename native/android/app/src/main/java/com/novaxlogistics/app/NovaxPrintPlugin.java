package com.novaxlogistics.app;

import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.Drawable;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.WebView;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * window.print() for the portal. Android's web view ignores window.print(), so the portal calls
 * NovaxPrint.print() instead (see the native bridge at the end of client-app.js). This opens the
 * system print dialog on the current page, with its print CSS, and resolves when the dialog closes,
 * which is when the portal fires afterprint and tidies up the print area.
 */
@CapacitorPlugin(name = "NovaxPrint")
public class NovaxPrintPlugin extends Plugin {

    @PluginMethod
    public void print(final PluginCall call) {
        final String name = call.getString("name", "NovaX");
        getActivity().runOnUiThread(() -> {
            try {
                final WebView webView = getBridge().getWebView();
                // The page margins on paper are painted with the web view's own background, which is
                // the app's dark green. White while printing; put back when the dialog closes.
                final Drawable oldBackground = webView.getBackground();
                webView.setBackgroundColor(Color.WHITE);
                PrintManager pm = (PrintManager) getContext().getSystemService(Context.PRINT_SERVICE);
                final PrintDocumentAdapter inner = webView.createPrintDocumentAdapter(name);
                PrintDocumentAdapter wrapped = new PrintDocumentAdapter() {
                    private boolean finished = false;

                    @Override
                    public void onStart() {
                        inner.onStart();
                    }

                    @Override
                    public void onLayout(PrintAttributes oldAttributes, PrintAttributes newAttributes, CancellationSignal cancellationSignal, LayoutResultCallback callback, Bundle extras) {
                        inner.onLayout(oldAttributes, newAttributes, cancellationSignal, callback, extras);
                    }

                    @Override
                    public void onWrite(PageRange[] pages, ParcelFileDescriptor destination, CancellationSignal cancellationSignal, WriteResultCallback callback) {
                        inner.onWrite(pages, destination, cancellationSignal, callback);
                    }

                    @Override
                    public void onFinish() {
                        inner.onFinish();
                        if (finished) return;
                        finished = true;
                        if (oldBackground != null) webView.setBackground(oldBackground);
                        else webView.setBackgroundColor(Color.parseColor("#04100b"));
                        JSObject ret = new JSObject();
                        ret.put("closed", true);
                        call.resolve(ret);
                    }
                };
                pm.print(name, wrapped, null);
            } catch (Exception e) {
                getBridge().getWebView().setBackgroundColor(Color.parseColor("#04100b"));
                call.reject("Printing is not available on this phone: " + e.getMessage());
            }
        });
    }
}
