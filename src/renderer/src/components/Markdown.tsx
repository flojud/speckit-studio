import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { renderWikiLinks } from '../../../shared/wiki'

interface Props {
  text: string
  /** Enables `[[wikilinks]]`; `exists` styles links to missing pages differently. */
  onWikiLink?: (name: string) => void
  exists?: (name: string) => boolean
}

export function Markdown({ text, onWikiLink, exists }: Props): React.JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            if (href?.startsWith('#wiki/')) {
              const name = decodeURIComponent(href.slice(6))
              const missing = exists && !exists(name)
              return (
                <a
                  href={href}
                  title={missing ? `Create "${name}"` : name}
                  className={missing ? 'opacity-60 border-b border-dashed border-current no-underline' : undefined}
                  onClick={(e) => (e.preventDefault(), onWikiLink?.(name))}
                >
                  {children}
                </a>
              )
            }
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            )
          }
        }}
      >
        {onWikiLink ? renderWikiLinks(text) : text}
      </ReactMarkdown>
    </div>
  )
}
