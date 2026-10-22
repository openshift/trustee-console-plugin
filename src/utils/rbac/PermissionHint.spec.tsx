import { render, screen } from '@testing-library/react';
import PermissionHint from './PermissionHint';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('PermissionHint', () => {
  it('renders nothing when allowed is true', () => {
    const { container } = render(<PermissionHint allowed={true} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing while loading', () => {
    const { container } = render(<PermissionHint allowed={false} loading={true} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a warning alert when allowed is false and not loading', () => {
    render(<PermissionHint allowed={false} />);
    expect(screen.getByText('Insufficient permissions')).toBeTruthy();
    expect(
      screen.getByText(
        'You do not have permission to perform this action. Contact a cluster administrator.',
      ),
    ).toBeTruthy();
  });
});
