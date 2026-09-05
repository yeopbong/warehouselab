declare const __CODE_VERSION__: string;
export const CODE_VERSION = typeof __CODE_VERSION__ === 'string' ? __CODE_VERSION__ : 'dev-dirty';
