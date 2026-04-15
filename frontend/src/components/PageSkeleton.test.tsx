import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageSkeleton } from './PageSkeleton';

describe('PageSkeleton', () => {
  it('renders without crashing', () => {
    const { container } = render(<PageSkeleton />);
    expect(container.firstChild).toBeTruthy();
  });

  it('has role="status" for accessibility', () => {
    render(<PageSkeleton />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('has aria-label "Loading page"', () => {
    render(<PageSkeleton />);
    expect(screen.getByLabelText('Loading page')).toBeInTheDocument();
  });

  it('has aria-live="polite"', () => {
    render(<PageSkeleton />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  it('displays "Loading..." text', () => {
    render(<PageSkeleton />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('contains the spinner element with animate class', () => {
    const { container } = render(<PageSkeleton />);
    const spinner = container.querySelector('[class*="animate-"]');
    expect(spinner).toBeTruthy();
  });

  it('has flex layout classes on the wrapper', () => {
    const { container } = render(<PageSkeleton />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain('flex');
    expect(wrapper.className).toContain('flex-col');
  });

  it('has min-height class for proper layout', () => {
    const { container } = render(<PageSkeleton />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain('min-h-');
  });

  it('contains a rounded spinner div', () => {
    const { container } = render(<PageSkeleton />);
    const spinner = container.querySelector('.rounded-full');
    expect(spinner).toBeTruthy();
  });

  it('has font-mono on loading text', () => {
    render(<PageSkeleton />);
    const text = screen.getByText('Loading...');
    expect(text.className).toContain('font-mono');
  });
});
