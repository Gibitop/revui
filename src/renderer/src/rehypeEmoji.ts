import { get as getEmoji } from 'node-emoji'
import { SKIP, visit } from 'unist-util-visit'
import type { Root } from 'hast'

export function rehypeEmoji() {
  return (tree: Root) => {
    visit(tree, (node) => {
      if (node.type === 'element' && ['code', 'pre'].includes(node.tagName)) return SKIP
      if (node.type === 'text') {
        node.value = node.value.replace(
          /:\+1:|:-1:|:[\w-]+:/g,
          (shortcode) => getEmoji(shortcode) ?? shortcode,
        )
      }
    })
  }
}
