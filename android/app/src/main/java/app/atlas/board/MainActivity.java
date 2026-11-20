package app.atlas.board;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.Menu;
import android.view.MenuItem;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;

public class MainActivity extends Activity {
    private static final String PREFS = "atlas";
    private static final String KEY = "address";
    private static final int FILE_CHOOSER = 41;

    private WebView board;
    private LinearLayout gate;
    private EditText address;
    private ValueCallback<Uri[]> fileCallback;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        board = findViewById(R.id.board);
        gate = findViewById(R.id.gate);
        address = findViewById(R.id.address);
        Button open = findViewById(R.id.open);

        WebSettings settings = board.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        board.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false;
            }
        });
        board.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent intent = params.createIntent();
                try {
                    startActivityForResult(intent, FILE_CHOOSER);
                } catch (Exception ignored) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        String saved = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY, "");
        address.setText(saved);
        open.setOnClickListener(v -> openBoard(address.getText().toString()));
        if (saved != null && saved.startsWith("http")) openBoard(saved);
    }

    private void openBoard(String raw) {
        String url = raw == null ? "" : raw.trim();
        if (!url.startsWith("http://") && !url.startsWith("https://")) return;
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY, url).apply();
        gate.setVisibility(LinearLayout.GONE);
        board.setVisibility(WebView.VISIBLE);
        board.loadUrl(url);
    }

    private void showGate() {
        board.stopLoading();
        board.setVisibility(WebView.GONE);
        gate.setVisibility(LinearLayout.VISIBLE);
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(0, 1, 0, "Change address");
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == 1) {
            showGate();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    @Override
    public void onBackPressed() {
        if (board.getVisibility() == WebView.VISIBLE && board.canGoBack()) board.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER && fileCallback != null) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) result = new Uri[]{data.getData()};
            fileCallback.onReceiveValue(result);
            fileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }
}
