package httpapi

import (
	"context"
	"encoding/json"
)

func (s *Server) processingShelves(ctx context.Context, d *processingDescription) error {
	d.Shelves = []string{}
	d.ShelfNames = []string{}
	if len(d.Documents) == 0 {
		return nil
	}
	categories, err := s.loadCategories(ctx)
	if err != nil {
		return err
	}
	all, err := s.loadAllMeta(ctx)
	if err != nil {
		return err
	}
	names := map[string]bool{}
	for _, key := range d.Documents {
		for _, name := range all[key].Categories {
			names[name] = true
		}
	}
	for _, category := range categories {
		if names[category.Name] {
			d.Shelves = append(d.Shelves, category.ID)
			d.ShelfNames = append(d.ShelfNames, category.Name)
		}
	}
	return nil
}

func (s *Server) protectRemovedCategory(ctx context.Context, name string) error {
	s.processingMu.Lock()
	defer s.processingMu.Unlock()
	categories, err := s.loadCategories(ctx)
	if err != nil {
		return err
	}
	id := ""
	for _, category := range categories {
		if category.Name == name {
			id = category.ID
		}
	}
	p, err := s.processingPolicy(ctx)
	if err != nil {
		return err
	}
	if id == "" || p.Shelves[id] != "deny" {
		return nil
	}
	all, err := s.loadAllMeta(ctx)
	if err != nil {
		return err
	}
	err = s.appStateStore.Update(ctx, processingPolicyKey, func(raw []byte, exists bool) ([]byte, error) {
		if exists {
			if err := json.Unmarshal(raw, &p); err != nil {
				return nil, err
			}
		}
		if p.Documents == nil {
			p.Documents = map[string]string{}
		}
		for key, meta := range all {
			for _, category := range meta.Categories {
				if category == name {
					p.Documents[key] = "deny"
				}
			}
		}
		p.Revision++
		return json.Marshal(p)
	})
	if err == nil {
		s.revokeProcessingLocked()
	}
	return err
}

func (s *Server) revokeProcessingLocked() {
	if s.processingCancel != nil {
		s.processingCancel()
	}
	s.processingEpoch, s.processingCancel = context.WithCancel(context.Background())
	s.processingTickets = map[string]processingTicket{}
}

func (s *Server) processingDocumentMode(ctx context.Context, p processingPolicy, key string) (string, error) {
	d := processingDescription{Documents: []string{key}}
	if err := s.processingShelves(ctx, &d); err != nil {
		return "", err
	}
	return effectiveProcessingMode(p, d), nil
}
