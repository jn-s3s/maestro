import { type ComponentProps, type JSX } from "react";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { FileLang } from "../../../shared/types";

interface Props {
    content: string;
    lang: FileLang;
}

type AnchorProps = ComponentProps<"a"> & ExtraProps;

/**
 * Renders a Markdown link, opening external URLs in the default browser
 * through the validated `shell:openExternal` bridge instead of letting the
 * window navigate away. In-page `#` anchors keep normal anchor behavior.
 */
function MarkdownLink({
    href,
    children,
    node: _node,
    ...rest
}: AnchorProps): JSX.Element {
    if (!href) {
        return <a {...rest}>{children}</a>;
    }
    if (!href.startsWith("#")) {
        return (
            <a
                {...rest}
                href={href}
                onClick={(e) => {
                    e.preventDefault();
                    void window.api.openExternal(href);
                }}
            >
                {children}
            </a>
        );
    }
    return (
        <a {...rest} href={href}>
            {children}
        </a>
    );
}

const markdownComponents = {
    a: MarkdownLink,
};

/**
 * Live Markdown preview pane rendered next to the editor for Markdown
 * files only. The renderer only mounts this component when `lang` is
 * `"markdown"`, so the non-Markdown empty state is no longer needed.
 *
 * @param content - The editor content to render.
 */
export default function PreviewPane({ content }: Props): JSX.Element {
    return (
        <div className="markdown-preview min-h-0 flex-1 overflow-y-auto bg-app px-5 py-4 font-sans text-sm leading-relaxed text-primary">
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={markdownComponents}
            >
                {content}
            </ReactMarkdown>
        </div>
    );
}
