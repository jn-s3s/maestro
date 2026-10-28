import { useEffect, useRef, type ReactElement } from "react";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { json } from "@codemirror/lang-json";
import { basicSetup } from "codemirror";
import { editorTheme } from "../renderer/src/components/editor/themes";

interface Props {
    content: string;
    reloadKey: number;
    onChange: (content: string) => void;
    onSave: () => void;
}

export default function FixtureEditor({
    content,
    reloadKey,
    onChange,
    onSave,
}: Props): ReactElement {
    const host = useRef<HTMLDivElement>(null);
    const save = useRef(onSave);
    useEffect(() => {
        save.current = onSave;
    }, [onSave]);
    useEffect(() => {
        if (!host.current) {
            return;
        }
        const view = new EditorView({
            parent: host.current,
            state: EditorState.create({
                doc: content,
                extensions: [
                    basicSetup,
                    json(),
                    ...editorTheme("light"),
                    EditorView.lineWrapping,
                    EditorView.contentAttributes.of({
                        "aria-label": "Synthetic JSON fixture",
                    }),
                    Prec.high(
                        keymap.of([
                            {
                                key: "Mod-s",
                                run: () => {
                                    save.current();
                                    return true;
                                },
                            },
                        ]),
                    ),
                    EditorView.updateListener.of((update) => {
                        if (update.docChanged) {
                            onChange(update.state.doc.toString());
                        }
                    }),
                ],
            }),
        });
        return () => {
            view.destroy();
        };
    }, [content, reloadKey, onChange]);
    return <div ref={host} className="h-full" />;
}
