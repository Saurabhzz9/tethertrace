package com.example.hello;

import android.app.Activity;
import android.os.Bundle;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

public class MainActivity extends Activity {
    private int count = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        TextView label = new TextView(this);
        label.setText("Count: 0");
        Button button = new Button(this);
        button.setText("Add one");
        button.setOnClickListener(v -> label.setText("Count: " + (++count)));
        root.addView(label);
        root.addView(button);
        setContentView(root);
    }
}
