import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Full markdown renderer for LLM-generated / dbt content -- descriptions,
 * overview.md, doc blocks, AI Assistant chat answers. Uses react-markdown +
 * remark-gfm so we get real support for tables, headers, lists, code
 * blocks, blockquotes, and inline formatting (bold/italic/code/links).
 * Shared across pages rather than duplicated per-caller since any surface
 * that renders LLM output benefits from this the same way.
 */
export function SimpleMarkdown({ text }: { text: string }) {
  return (
    <div className="text-xs text-gray-700 leading-relaxed dbt-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="text-base font-semibold text-gray-900 mt-4 mb-2">{children}</h1>,
          h2: ({ children }) => <h2 className="text-sm font-semibold text-gray-900 mt-3 mb-2">{children}</h2>,
          h3: ({ children }) => <h3 className="text-xs font-semibold text-gray-900 uppercase tracking-wider mt-3 mb-1.5">{children}</h3>,
          p: ({ children }) => <p className="text-xs text-gray-700 mb-2 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="list-disc pl-5 mb-2 space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 space-y-0.5">{children}</ol>,
          li: ({ children }) => <li className="text-xs text-gray-700">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold text-gray-900">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          code: ({ children, className }) => {
            const isBlock = className?.startsWith('language-');
            if (isBlock) {
              return (
                <pre className="bg-gray-50 border border-gray-200 rounded p-2 my-2 text-[11px] font-mono overflow-x-auto">
                  <code>{children}</code>
                </pre>
              );
            }
            return <code className="bg-gray-100 px-1 rounded font-mono text-[11px]">{children}</code>;
          },
          pre: ({ children }) => <>{children}</>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-gray-300 pl-3 my-2 text-gray-600 italic">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto my-2 -mx-1">
              <table className="min-w-full text-[11px] border border-gray-200 rounded">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-gray-50 border-b border-gray-200">{children}</thead>,
          tbody: ({ children }) => <tbody className="divide-y divide-gray-100">{children}</tbody>,
          tr: ({ children }) => <tr>{children}</tr>,
          th: ({ children }) => <th className="px-2 py-1.5 text-left font-semibold text-gray-800 whitespace-nowrap">{children}</th>,
          td: ({ children }) => <td className="px-2 py-1.5 text-gray-700 align-top">{children}</td>,
          hr: () => <hr className="my-3 border-gray-200" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
