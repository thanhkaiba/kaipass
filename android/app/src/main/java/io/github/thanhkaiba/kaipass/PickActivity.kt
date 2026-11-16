package io.github.thanhkaiba.kaipass

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.autofill.AutofillManager
import android.widget.BaseAdapter
import android.widget.CheckBox
import android.widget.EditText
import android.widget.ListView
import android.widget.TextView
import java.text.Normalizer

/** "Search KaiPass": pick any login for this app or page, and optionally remember the choice. */
class PickActivity : Activity() {
    private var shown: List<Entry> = emptyList()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val form = FormIds.from(intent)
        val all = FillIndex.current()
        if (form == null || all == null) {
            // Locked meanwhile: unlocking would need the web app, so ask the user to start again.
            android.widget.Toast.makeText(this, R.string.locked_again, android.widget.Toast.LENGTH_LONG).show()
            setResult(RESULT_CANCELED)
            return finish()
        }
        setContentView(R.layout.pick)
        findViewById<TextView>(R.id.target).text = form.target.label
        val remember = findViewById<CheckBox>(R.id.remember)
        remember.text = getString(R.string.pick_remember, form.target.label)
        val list = findViewById<ListView>(R.id.list)
        val empty = findViewById<TextView>(R.id.empty)
        val usable = Responses.usable(all, form).sortedBy { it.title.lowercase() }

        val adapter = object : BaseAdapter() {
            override fun getCount() = shown.size
            override fun getItem(i: Int) = shown[i]
            override fun getItemId(i: Int) = i.toLong()
            override fun getView(i: Int, convert: View?, parent: ViewGroup): View {
                val v = convert ?: layoutInflater.inflate(R.layout.pick_row, parent, false)
                v.findViewById<TextView>(R.id.title).text = shown[i].title.ifEmpty { "(không tên)" }
                v.findViewById<TextView>(R.id.subtitle).text = Responses.subtitleOf(shown[i])
                return v
            }
        }
        list.adapter = adapter
        fun filter(q: String) {
            val n = fold(q)
            shown = if (n.isEmpty()) usable else usable.filter { fold(it.title).contains(n) || fold(it.username).contains(n) || it.hosts.any { h -> h.contains(n) } }
            adapter.notifyDataSetChanged()
            empty.visibility = if (shown.isEmpty()) View.VISIBLE else View.GONE
        }
        filter("")
        findViewById<EditText>(R.id.search).addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun afterTextChanged(s: Editable?) = filter(s?.toString() ?: "")
        })
        list.setOnItemClickListener { _, _, i, _ ->
            val e = shown[i]
            val dataset = Responses.filled(this, e, form) ?: return@setOnItemClickListener
            if (remember.isChecked) Learned.add(this, form.target, e.id)
            FillIndex.touch()
            FillActivity.copyOtpIfNeeded(this, e, form)
            setResult(RESULT_OK, Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, dataset))
            finish()
        }
    }

    private fun fold(s: String) = Normalizer.normalize(s, Normalizer.Form.NFD).replace(Regex("\\p{M}+"), "").lowercase().replace('đ', 'd').trim()
}
