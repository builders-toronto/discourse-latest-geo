# frozen_string_literal: true
# name: discourse-latest-geo
# about: GEO prioritization if the user has not set it already
# version: 0.2.0
# authors: Renovation.Reviews

enabled_site_setting :rr_geo_enabled

after_initialize do
  module ::RRGeo
    class Util
      def self.tokens_from_location(loc)
        return [] if loc.blank?
        raw = loc.to_s.downcase.strip

        words = raw.split(/[^a-z0-9]+/).select { |t| t.present? && t.length >= 3 }

        phrases = []
        raw.scan(/[a-z0-9]+(?:\s+[a-z0-9]+)+/) { |ph| phrases << ph.gsub(/\s+/, "-") }

        (words + phrases).uniq
      end

      def self.ilike_any_clause(tokens)
        return nil if tokens.blank?
        conn = ActiveRecord::Base.connection

        ors =
          tokens.flat_map do |t|
            pat = "%" + ActiveRecord::Base.sanitize_sql_like(t) + "%"
            q = conn.quote(pat)
            [
              "topics.title ILIKE #{q}",
              "fp.raw ILIKE #{q}",
              "tags.name ILIKE #{q}",
              "categories.name ILIKE #{q}",
            ]
          end

        ors.any? ? ors.join(" OR ") : nil
      end
    end
  end

  TopicQuery.results_filter_callbacks << Proc.new do |query, result, user|
    begin
      next result unless SiteSetting.rr_geo_enabled

      # Only apply to the "latest" feed
      filter =
        (
          begin
            query.instance_variable_get(:@filter)
          rescue StandardError
            nil
          end
        )
      next result unless filter == :latest

      the_user = user || (query.respond_to?(:guardian) ? query.guardian&.user : nil)
      loc = the_user&.user_profile&.location
      tokens = ::RRGeo::Util.tokens_from_location(loc)
      next result if tokens.blank?

      where_any = ::RRGeo::Util.ilike_any_clause(tokens)
      next result unless where_any

      if SiteSetting.rr_geo_debug
        Rails.logger.info("[rr_geo] tokens=#{tokens.inspect} user=#{the_user&.username}")
      end

      ranked =
        result
          .joins("LEFT JOIN posts fp ON fp.id = topics.first_post_id")
          .joins("LEFT JOIN topic_tags tt ON tt.topic_id = topics.id")
          .joins("LEFT JOIN tags ON tags.id = tt.tag_id")
          .joins("LEFT JOIN categories ON categories.id = topics.category_id")
          .select(<<~SQL)
          topics.*,
          (CASE WHEN (#{where_any}) THEN 1 ELSE 0 END) AS rr_geo_match
        SQL
          .reorder(Arel.sql("rr_geo_match DESC, topics.bumped_at DESC"))
          .distinct

      if SiteSetting.rr_geo_debug
        sample = ranked.limit(10).pluck(:rr_geo_match, :title)
        Rails.logger.info("[rr_geo] sample(top10)=#{sample.inspect}")
      end

      ranked
    rescue => e
      Rails.logger.warn("[rr_geo] failed: #{e.class} #{e.message}")
      result
    end
  end
end
