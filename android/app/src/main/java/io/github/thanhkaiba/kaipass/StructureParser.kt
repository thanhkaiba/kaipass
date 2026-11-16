package io.github.thanhkaiba.kaipass

import android.app.assist.AssistStructure
import android.view.View
import android.view.autofill.AutofillId

/** A screen, as autofill sees it: who asked, which page (in a browser), and its fields. */
class Parsed(
    val packageName: String,
    val webDomain: String?,
    val ids: List<AutofillId>,
    val fields: List<FieldInfo>,
) {
    val form: Form = Classifier.classify(fields)
    val target: Target get() = Target(webDomain?.let(Matcher::normalizeDomain)?.takeIf { it.isNotEmpty() }, packageName)
    fun idsOf(indices: List<Int>): List<AutofillId> = indices.map { ids[it] }
    fun valueOf(indices: List<Int>): String = indices.firstNotNullOfOrNull { fields[it].value?.takeIf(String::isNotEmpty) } ?: ""
}

object StructureParser {
    fun parse(structure: AssistStructure): Parsed {
        val ids = mutableListOf<AutofillId>()
        val fields = mutableListOf<FieldInfo>()
        var domain: String? = null

        fun walk(node: AssistStructure.ViewNode) {
            if (node.visibility != View.VISIBLE) return
            if (domain == null && !node.webDomain.isNullOrEmpty()) domain = node.webDomain
            val id = node.autofillId
            val html = node.htmlInfo
            val attrs = html?.attributes?.associate { (it.first ?: "").lowercase() to (it.second ?: "") } ?: emptyMap()
            val isInput = html?.tag.equals("input", ignoreCase = true) ||
                node.className?.contains("EditText") == true ||
                node.autofillHints?.isNotEmpty() == true
            if (id != null && isInput && node.autofillType == View.AUTOFILL_TYPE_TEXT && node.isEnabled) {
                ids += id
                fields += FieldInfo(
                    hints = node.autofillHints?.toList() ?: emptyList(),
                    inputType = node.inputType,
                    htmlType = attrs["type"]?.takeIf { html != null } ?: if (html != null) "text" else null,
                    autocomplete = attrs["autocomplete"],
                    words = listOfNotNull(
                        node.idEntry, attrs["name"], attrs["id"], attrs["placeholder"], attrs["aria-label"],
                        attrs["label"], node.hint?.toString(), node.contentDescription?.toString(),
                    ).filter { it.isNotBlank() },
                    value = node.autofillValue?.takeIf { it.isText }?.textValue?.toString(),
                )
            }
            for (i in 0 until node.childCount) walk(node.getChildAt(i))
        }

        for (i in 0 until structure.windowNodeCount) walk(structure.getWindowNodeAt(i).rootViewNode)
        return Parsed(structure.activityComponent.packageName, domain, ids, fields)
    }
}
