/// <reference types="vite/client" />

declare namespace JSX {
  interface IntrinsicElements {
    'scout-copilot': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
      copilot_id?: string;
      embedded?: string;
      open?: string;
      show_minimize?: string;
      width?: string;
      height?: string;
    };
  }
}
