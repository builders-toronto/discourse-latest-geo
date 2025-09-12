# frozen_string_literal: true
# name: discourse-latest-geo
# about: GEO prioritization if the user has not set it already
# version: 0.2.1
# authors: Renovation.Reviews

enabled_site_setting :rr_geo_enabled

after_initialize do
  module ::RrGeo
    class Util
      def self.tokens_from_location(loc)
        return [] if loc.blank?
        raw = loc.to_s.downcase.strip
        words = raw.split(/[^a-z0-9]+/).select { |t| t.present? && t.length >= 3 }
        bigrams = words.each_cons(2).map { |a, b| "#{a} #{b}" }
        (words + bigrams).uniq
      end

      def self.quote_patterns(patterns)
        patterns.map { |p| ActiveRecord::Base.connection.quote(p) }.join(",")
      end
    end
  end

  ::TopicQuery.class_eval do
    def list_latest(*args)
      options = args.first || {}
      rel = latest_results(options)

      if SiteSetting.rr_geo_enabled && @guardian&.user
        location = @guardian.user.user_profile&.location
        tokens = ::RrGeo::Util.tokens_from_location(location)

        if tokens.present?
          patterns = tokens.map { |t| "%#{ActiveRecord::Base.sanitize_sql_like(t)}%" }
          q_array = ::RrGeo::Util.quote_patterns(patterns)
          rel =
            rel
              .joins(<<~SQL)
              LEFT JOIN topic_tags tt ON tt.topic_id = topics.id
              LEFT JOIN tags tg ON tg.id = tt.tag_id
              LEFT JOIN categories c ON c.id = topics.category_id
            SQL
              .select(<<~SQL)
              topics.*,
              CASE
                WHEN topics.title ILIKE ANY (ARRAY[#{q_array}])
                 OR tg.name       ILIKE ANY (ARRAY[#{q_array}])
                 OR c.name        ILIKE ANY (ARRAY[#{q_array}])
                THEN 0 ELSE 1
              END AS rr_geo_rank
            SQL
              .distinct(true)
              .reorder(Arel.sql("rr_geo_rank ASC, topics.created_at DESC"))
        end
      end
      create_list(:latest, {}, rel)
    end
  end
end
