import type { ButtonHTMLAttributes } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "toolbar" | "toolbar-primary";
};

const variantClasses = {
  primary: "rounded-lg px-4 py-2 bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed",
  secondary: "rounded-lg px-4 py-2 border border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
  toolbar: "rounded-md px-2.5 py-1 border border-slate-200 bg-white text-xs text-slate-600 hover:bg-slate-50",
  "toolbar-primary": "rounded-md px-2.5 py-1 bg-blue-600 text-xs text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed",
};

export function Button({ variant = "primary", className = "", ...props }: ButtonProps) {
  return (
    <button
      className={`font-medium ${variantClasses[variant]} ${className}`}
      {...props}
    />
  );
}
