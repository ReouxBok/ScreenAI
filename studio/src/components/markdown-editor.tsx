"use client";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Heading2, Italic, List, ListOrdered, Quote } from "lucide-react";
import { useState } from "react";
export function MarkdownEditor({ name, initialValue }: { name: string; initialValue: string }) {
  const [markdown, setMarkdown] = useState(initialValue);
  const editor = useEditor({ immediatelyRender: false, extensions: [StarterKit, Markdown], content: initialValue, contentType: "markdown", onUpdate: ({ editor: instance }) => setMarkdown(instance.getMarkdown()) });
  const tools = [
    { label: "Gras", icon: Bold, active: editor?.isActive("bold"), run: () => editor?.chain().focus().toggleBold().run() },
    { label: "Italique", icon: Italic, active: editor?.isActive("italic"), run: () => editor?.chain().focus().toggleItalic().run() },
    { label: "Titre", icon: Heading2, active: editor?.isActive("heading", { level: 2 }), run: () => editor?.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: "Liste", icon: List, active: editor?.isActive("bulletList"), run: () => editor?.chain().focus().toggleBulletList().run() },
    { label: "Liste numérotée", icon: ListOrdered, active: editor?.isActive("orderedList"), run: () => editor?.chain().focus().toggleOrderedList().run() },
    { label: "Citation", icon: Quote, active: editor?.isActive("blockquote"), run: () => editor?.chain().focus().toggleBlockquote().run() },
  ];
  return <><input type="hidden" name={name} value={markdown} readOnly/><div className="toolbar" role="toolbar" aria-label="Mise en forme">{tools.map(({ label, icon: Icon, active, run }) => <button type="button" key={label} title={label} aria-label={label} aria-pressed={active} className={active ? "active" : ""} onClick={run}><Icon size={17}/></button>)}</div><EditorContent editor={editor}/></>;
}
