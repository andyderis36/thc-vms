package repository

import (
	"context"
	"crypto/rand"
	"fmt"
	"math/big"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

// visitRepository is the PostgreSQL adapter for domain.VisitRepository.
// The port is split across files by responsibility: this file owns creation
// and single-row reads, visit_list.go owns scoped pagination, visit_status.go
// owns atomic transitions, and visit_mapping.go owns row projections.
type visitRepository struct {
	pool *pgxpool.Pool
}

// Compile-time proof that the adapter satisfies its port.
var _ domain.VisitRepository = (*visitRepository)(nil)

// NewVisitRepository builds the PostgreSQL-backed domain.VisitRepository.
func NewVisitRepository(pool *pgxpool.Pool) domain.VisitRepository {
	return &visitRepository{pool: pool}
}

// visitCodeAttempts caps the VST-code regeneration loop on a code clash.
const visitCodeAttempts = 5

// Create persists a visit request with its visitors and purpose links in ONE
// transaction. The human visit code is minted here as VST- + 10 digits (the
// chk_visit_request_visit_id_format shape); a clash regenerates the code and
// retries the whole transaction. No status_history row is written: the visit
// is born 'requested' and its first history row belongs to its first explicit
// transition, so the atomicity tests can assert exactly one row per UpdateStatus.
func (r *visitRepository) Create(
	ctx context.Context,
	visit domain.VisitRequest,
	visitors []domain.Visitor,
	purposeIDs []domain.UUID,
) (domain.VisitRequest, error) {
	picID, err := fromDomainUUID(visit.PICUserID)
	if err != nil {
		return domain.VisitRequest{}, err
	}
	locationID, err := fromDomainUUID(visit.LocationID)
	if err != nil {
		return domain.VisitRequest{}, err
	}
	vendorID, err := pgNullUUID(visit.VendorID)
	if err != nil {
		return domain.VisitRequest{}, err
	}
	purposes := make([]uuid.UUID, 0, len(purposeIDs))
	for _, id := range purposeIDs {
		parsed, err := fromDomainUUID(id)
		if err != nil {
			return domain.VisitRequest{}, err
		}
		purposes = append(purposes, parsed)
	}

	var created db.VisitRequest
	var lastErr error
	for range visitCodeAttempts {
		code, err := genVisitCode()
		if err != nil {
			return domain.VisitRequest{}, err
		}
		err = WithTx(ctx, r.pool, func(tx pgx.Tx) error {
			q := db.New(r.pool).WithTx(tx)
			row, err := q.CreateVisit(ctx, db.CreateVisitParams{
				VisitID:             code,
				PicUserID:           picID,
				VendorID:            vendorID,
				LocationID:          locationID,
				StartDate:           visit.StartDate,
				EndDate:             visit.EndDate,
				IsMultiDay:          visit.IsMultiDay,
				AssignmentLetterUrl: pgText(visit.AssignmentLetterURL),
				IsNdaAccepted:       visit.IsNDAAccepted,
				Notes:               pgText(visit.Notes),
			})
			if err != nil {
				return MapError(err)
			}
			for _, v := range visitors {
				if _, err := q.InsertVisitor(ctx, db.InsertVisitorParams{
					VisitRequestID: row.ID,
					Name:           v.Name,
					IDNumber:       v.IDNumber,
					Phone:          v.Phone,
					IDCardPhotoUrl: pgText(v.IDCardPhotoURL),
					PhotoUrl:       pgText(v.PhotoURL),
				}); err != nil {
					return MapError(err)
				}
			}
			for _, purposeID := range purposes {
				if err := q.InsertVisitPurpose(ctx, db.InsertVisitPurposeParams{
					VisitRequestID: row.ID,
					PurposeID:      purposeID,
				}); err != nil {
					return MapError(err)
				}
			}
			created = row
			return nil
		})
		if err == nil {
			return visitRowToDomain(created)
		}
		lastErr = err
	}
	return domain.VisitRequest{}, lastErr
}

// FindByID resolves one visit by primary key.
func (r *visitRepository) FindByID(ctx context.Context, id domain.UUID) (domain.VisitRequest, error) {
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return domain.VisitRequest{}, err
	}
	row, err := db.New(r.pool).GetVisitByID(ctx, db.GetVisitByIDParams{ID: parsed})
	if err != nil {
		return domain.VisitRequest{}, MapError(err)
	}
	visit, err := detailRowToDomain(row)
	if err != nil {
		return domain.VisitRequest{}, err
	}
	return visit, nil
}

// FindByVisitCode resolves one visit by its printed VST-XXXXXXXXXX code: the
// Triple-Mode Scanner manual fallback. A bogus code becomes ErrNotFound.
func (r *visitRepository) FindByVisitCode(ctx context.Context, code string) (domain.VisitRequest, error) {
	row, err := db.New(r.pool).GetVisitByVisitCode(ctx, db.GetVisitByVisitCodeParams{VisitID: code})
	if err != nil {
		return domain.VisitRequest{}, MapError(err)
	}
	visit, err := visitCodeRowToDomain(row)
	if err != nil {
		return domain.VisitRequest{}, err
	}
	return visit, nil
}

// genVisitCode mints a VST- + 10 digits code with crypto randomness.
func genVisitCode() (string, error) {
	const digits = "0123456789"
	code := make([]byte, 10)
	for i := range code {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(digits))))
		if err != nil {
			return "", fmt.Errorf("repository: mint visit code: %w: %v", domain.ErrDatabase, err)
		}
		code[i] = digits[n.Int64()]
	}
	return "VST-" + string(code), nil
}
