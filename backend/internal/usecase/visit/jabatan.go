package visit

import (
	"context"
)

// ListJabatan returns the distinct, alphabetically sorted Jabatan values that
// were previously registered on visitor rows. It feeds the roster combobox as
// suggestions while the field stays freely editable, so the list is never a
// catalogue.
//
// Every authenticated role may read it: the payload carries only free-text
// position labels, no personal data, so there is no branch or owner scope to
// apply. The repository already drops blanks and caps the result; an empty
// suggestion list is returned as a non-nil empty slice so the wire renders
// `"data": []` instead of null.
func (s *Service) ListJabatan(ctx context.Context) ([]string, error) {
	values, err := s.visits.ListVisitorJabatan(ctx)
	if err != nil {
		return nil, err
	}
	if values == nil {
		return []string{}, nil
	}
	return values, nil
}
